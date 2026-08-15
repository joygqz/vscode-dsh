import * as vscode from 'vscode';
import { delimiter, dirname } from 'node:path';
import { buildSpawnSpec, validateLaunchSettings } from './args';
import { launchSettingsFingerprint, readSettings } from './config';
import { findAvailableLoopbackPort } from './endpoint';
import { mergeEnvironment } from './environment';
import { isPortInUse } from './http';
import { Logger } from './output';
import { normalizeLoopbackUrl, portFromUrl } from './parse';
import { checkNodeRuntime, type NodeRuntime } from './runtime';
import {
  DshServerManager,
  isCancellationError,
  PortConflictError,
  StartCancelledError,
} from './serverManager';
import type {
  DshSettings,
  LaunchRequest,
  OpenLocation,
  ServerSnapshot,
  StartResult,
} from './types';
import { GuiPanel } from './webview';
import { resolveWorkingDirectory } from './workspace';

let app: ExtensionApp | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  app = new ExtensionApp(context);
  await app.initialize();
}

export async function deactivate(): Promise<void> {
  const current = app;
  app = undefined;
  await current?.dispose();
}

class ExtensionApp {
  private readonly logger = new Logger();
  private readonly panel = new GuiPanel();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly manager: DshServerManager;
  private readonly dshHome: string;
  private readonly runtimeCache = new Map<string, Promise<NodeRuntime>>();
  private readonly openPromises = new Map<OpenLocation, Promise<void>>();

  private lastSnapshot: ServerSnapshot = { state: 'stopped' };
  /** Adapter-owned state for Node/cwd/Remote preflight before manager.start(). */
  private operationSnapshot?: ServerSnapshot;
  private launchFingerprint?: string;
  private launchedWorkingDirectorySetting?: string;
  private restartRequired = false;
  private restartInProgress = false;
  private launchPromise?: Promise<StartResult | undefined>;
  private launchAbort?: AbortController;
  private lastExternalUrl?: string;
  private errorSource?: 'managed' | 'external';
  private pendingTrustAction?: () => Promise<void>;
  private contextQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(context: vscode.ExtensionContext) {
    this.dshHome = context.globalStorageUri.fsPath;
    this.manager = new DshServerManager({
      log: (message, kind) => this.logger.log(message, kind),
      onChanged: (snapshot) => this.onStateChanged(snapshot),
    });

    this.statusItem = vscode.window.createStatusBarItem(
      'vscode-dsh.status',
      vscode.StatusBarAlignment.Left,
      90
    );
    this.statusItem.name = 'DeepSeek Harness Launcher';
    this.statusItem.command = 'vscode-dsh.statusClick';
    this.renderStatus(this.lastSnapshot);
    this.statusItem.show();

    const register = (id: string, handler: (...args: unknown[]) => unknown) =>
      vscode.commands.registerCommand(id, handler);

    context.subscriptions.push(
      register('vscode-dsh.statusClick', () => this.onStatusClick()),
      register('vscode-dsh.open', () => this.openAt(readSettings().openLocation, true)),
      register('vscode-dsh.start', () => this.startCommand()),
      register('vscode-dsh.openInBrowser', () => this.openAt('browser', true)),
      register('vscode-dsh.openInEditor', () => this.openAt('editor', true)),
      register('vscode-dsh.connect', () => this.connectExternal()),
      register('vscode-dsh.stop', () => this.stopManaged()),
      register('vscode-dsh.disconnect', () => this.disconnectExternal()),
      register('vscode-dsh.restart', () => this.restartManaged()),
      register('vscode-dsh.cancel', () => this.cancelLaunch()),
      register('vscode-dsh.copyUrl', () => this.copyUrl()),
      register('vscode-dsh.showLogs', () => this.logger.show()),
      register('vscode-dsh.openSettings', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:joygqz.vscode-dsh')
      ),
      register('vscode-dsh.webview.refresh', () => this.refreshPanel()),
      register('vscode-dsh.webview.openBrowser', () => this.openPanelInBrowser()),
      register('vscode-dsh.webview.copyUrl', () => this.copyUrl(this.panel.getUrl())),
      vscode.workspace.onDidChangeConfiguration((event) => this.onConfigurationChanged(event)),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.onWorkspaceTrusted()),
      this.panel,
      this.logger,
      this.statusItem
    );
  }

  async initialize(): Promise<void> {
    this.logger.log('DeepSeek Harness Launcher 扩展已激活', 'info');
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(this.dshHome));
    await this.publish(this.lastSnapshot);
    const behavior = readSettings().startupBehavior;
    if (behavior === 'manual' || !vscode.workspace.isTrusted) return;
    void this.startForStartup(behavior === 'startAndOpen');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.launchAbort?.abort();
    await this.manager.dispose();
  }

  private async startForStartup(openWhenReady: boolean): Promise<void> {
    let result: StartResult | undefined;
    try {
      result = await this.ensureManagedStarted(false);
    } catch (error) {
      if (!isCancellationError(error)) await this.showStartError(error);
      return;
    }
    if (!result || !openWhenReady || this.manager.getSnapshot().state !== 'running') return;
    const location = readSettings().openLocation;
    try {
      await this.present(result.url, location);
    } catch (error) {
      await this.showOpenError(error, location);
    }
  }

  private async startCommand(): Promise<void> {
    let result: StartResult | undefined;
    try {
      result = await this.ensureManagedStarted(true, () => this.startCommand());
    } catch (error) {
      await this.showStartError(error);
      return;
    }
    if (!result) return;

    const choice = await vscode.window.showInformationMessage('DeepSeek Harness 已就绪。', '打开');
    if (choice !== '打开') return;
    const location = readSettings().openLocation;
    try {
      await this.present(result.url, location);
    } catch (error) {
      await this.showOpenError(error, location);
    }
  }

  private ensureManagedStarted(
    interactive: boolean,
    resumeAfterTrust?: () => Promise<void>
  ): Promise<StartResult | undefined> {
    if (this.launchPromise) {
      return this.launchPromise;
    }

    const snapshot = this.manager.getSnapshot();
    if (snapshot.state === 'running' && snapshot.url) {
      return Promise.resolve({ kind: 'already-running', url: snapshot.url });
    }

    const controller = new AbortController();
    const execute = () => this.doEnsureManagedStarted(interactive, controller.signal, resumeAfterTrust);
    const promise: Promise<StartResult | undefined> = Promise.resolve(
      interactive
      ? vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: '正在准备并启动 DeepSeek Harness…',
            cancellable: true,
          },
          async (_progress, token) => {
            const cancellation = token.onCancellationRequested(() => this.cancelLaunch());
            try {
              return await execute();
            } finally {
              cancellation.dispose();
            }
          }
        )
      : execute()
    );

    this.launchPromise = promise;
    this.launchAbort = controller;
    promise.then(
      () => this.finishLaunch(promise),
      (error) => this.finishLaunch(promise, error)
    );
    return promise;
  }

  private async doEnsureManagedStarted(
    interactive: boolean,
    signal: AbortSignal,
    resumeAfterTrust?: () => Promise<void>
  ): Promise<StartResult | undefined> {
    if (!(await this.ensureTrusted(interactive, resumeAfterTrust))) return undefined;
    this.throwIfCancelled(signal);
    this.setOperation({ state: 'starting' });
    this.errorSource = 'managed';

    const settings = readSettings();
    const environment = mergeEnvironment(process.env, settings.environment);
    const runtime = await awaitAbortable(this.ensureNodeRuntime(environment), signal);
    const cwd = await awaitAbortable(resolveWorkingDirectory(settings.workingDirectory, interactive), signal);
    if (!cwd) {
      this.setOperation(undefined);
      if (!interactive) this.logger.log('没有可用的工作区文件夹，已跳过自动启动', 'info');
      return undefined;
    }

    const remoteSettings = await this.prepareRemoteSettings(settings, signal);
    const launchSettings = withVerifiedRuntime(remoteSettings, runtime, environment, this.dshHome);
    validateLaunchSettings(launchSettings);
    this.throwIfCancelled(signal);
    const request: LaunchRequest = { settings: launchSettings, cwd, npxPath: runtime.npxPath };
    this.launchFingerprint = launchSettingsFingerprint(settings);
    this.launchedWorkingDirectorySetting = settings.workingDirectory;
    this.restartRequired = false;
    // manager.start publishes `starting` synchronously; hand off the overlay
    // without emitting a transient stopped state.
    this.operationSnapshot = undefined;
    return this.startWithRemotePortRetry(request, settings, runtime, environment, signal);
  }

  private openAt(location: OpenLocation, interactive: boolean): Promise<void> {
    const existing = this.openPromises.get(location);
    if (existing) return existing;
    const promise = this.doOpenAt(location, interactive);
    this.openPromises.set(location, promise);
    promise.then(
      () => {
        if (this.openPromises.get(location) === promise) this.openPromises.delete(location);
      },
      () => {
        if (this.openPromises.get(location) === promise) this.openPromises.delete(location);
      }
    );
    return promise;
  }

  private async doOpenAt(location: OpenLocation, interactive: boolean): Promise<void> {
    let started: StartResult | undefined;
    try {
      started = await this.ensureManagedStarted(interactive, () => this.openAt(location, true));
    } catch (error) {
      await this.showStartError(error);
      return;
    }
    if (!started) return;

    const snapshot = this.manager.getSnapshot();
    if (snapshot.ownership === 'external' && !(await this.manager.revalidateExternal())) return;
    const url = this.manager.getUrl();
    if (!url) return;
    try {
      await this.present(url, location);
    } catch (error) {
      await this.showOpenError(error, location);
    }
  }

  private async present(internalUrl: string, location: OpenLocation): Promise<void> {
    if (location === 'editor') {
      await this.panel.show(internalUrl);
      return;
    }
    // openExternal resolves localhost through the active Remote tunnel itself.
    const opened = await vscode.env.openExternal(vscode.Uri.parse(internalUrl));
    if (!opened) throw new Error('系统未能打开浏览器，请改用“在 VS Code 中打开”');
  }

  private async connectExternal(): Promise<void> {
    if (!(await this.ensureTrusted(true, () => this.connectExternal()))) return;
    if (this.launchPromise || !['stopped', 'error'].includes(this.manager.getSnapshot().state)) {
      void vscode.window.showWarningMessage('另一个启动或重启操作正在进行，请先取消或等待完成。');
      return;
    }
    const input = await vscode.window.showInputBox({
      title: '连接到运行中的 DeepSeek Harness',
      prompt: '只允许工作区所在环境的回环地址；扩展不会停止或重启外部服务',
      value: this.lastExternalUrl ?? 'http://127.0.0.1:3080',
      ignoreFocusOut: true,
      validateInput: (value) => (normalizeLoopbackUrl(value) ? undefined : '请输入工作区环境的 HTTP 回环地址'),
    });
    if (!input) return;
    const url = normalizeLoopbackUrl(input);
    if (!url) return;
    if (this.launchPromise || !['stopped', 'error'].includes(this.manager.getSnapshot().state)) {
      void vscode.window.showWarningMessage('服务状态已在输入期间改变，请确认后重试连接。');
      return;
    }
    this.lastExternalUrl = url;
    await this.connectTo(url, true);
  }

  private async connectTo(url: string, openWhenReady: boolean): Promise<void> {
    this.errorSource = 'external';
    let result;
    try {
      result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '正在连接 DeepSeek Harness…',
          cancellable: true,
        },
        async (_progress, token) => {
          const cancellation = token.onCancellationRequested(() => this.cancelLaunch());
          try {
            return await this.manager.connect(url);
          } finally {
            cancellation.dispose();
          }
        }
      );
    } catch (error) {
      await this.showStartError(error);
      return;
    }

    if (this.manager.getSnapshot().ownership !== 'external') {
      void vscode.window.showWarningMessage('当前运行的是扩展托管服务，未切换为外部连接。');
      return;
    }
    this.launchFingerprint = undefined;
    this.launchedWorkingDirectorySetting = undefined;
    this.restartRequired = false;
    if (!openWhenReady) return;
    const location = readSettings().openLocation;
    try {
      await this.present(result.url, location);
    } catch (error) {
      await this.showOpenError(error, location);
    }
  }

  private async stopManaged(): Promise<void> {
    this.cancelLaunch();
    if (this.launchPromise) await this.launchPromise.catch(() => undefined);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在停止 DeepSeek Harness…' },
        () => this.manager.stop()
      );
    } catch (error) {
      const choice = await vscode.window.showErrorMessage(`停止失败：${messageOf(error)}`, '查看输出');
      if (choice === '查看输出') this.logger.show();
    }
  }

  private async disconnectExternal(): Promise<void> {
    await this.manager.stop();
    void vscode.window.showInformationMessage('已断开外部 DeepSeek Harness；外部服务仍在运行。');
  }

  private async restartManaged(): Promise<void> {
    if (this.launchPromise) return;
    if (!(await this.ensureTrusted(true, () => this.restartManaged()))) return;

    const controller = new AbortController();
    const promise: Promise<StartResult | undefined> = Promise.resolve(vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在准备并重启 DeepSeek Harness…',
        cancellable: true,
      },
      async (_progress, token) => {
        const cancellation = token.onCancellationRequested(() => this.cancelLaunch());
        try {
          return await this.doRestartManaged(controller.signal);
        } finally {
          cancellation.dispose();
        }
      }
    ));
    this.launchPromise = promise;
    this.launchAbort = controller;
    promise.then(
      () => this.finishLaunch(promise),
      (error) => this.finishLaunch(promise, error)
    );

    let result: StartResult | undefined;
    try {
      result = await promise;
    } catch (error) {
      await this.showStartError(error);
      return;
    }
    if (!result || this.panel.isOpen()) return;
    const choice = await vscode.window.showInformationMessage('DeepSeek Harness 已重新启动。', '打开');
    if (choice !== '打开') return;
    const location = readSettings().openLocation;
    try {
      await this.present(result.url, location);
    } catch (error) {
      await this.showOpenError(error, location);
    }
  }

  private async doRestartManaged(signal: AbortSignal): Promise<StartResult> {
    const current = this.manager.getSnapshot();
    this.setOperation({ state: 'starting', ownership: 'managed', cwd: current.cwd });
    this.errorSource = 'managed';
    const settings = readSettings();
    const environment = mergeEnvironment(process.env, settings.environment);
    const runtime = await awaitAbortable(this.ensureNodeRuntime(environment), signal);
    // A blank setting means a normal restart keeps the instance's established
    // working directory instead of drifting when the active editor changes.
    const cwd =
      current.cwd && settings.workingDirectory === this.launchedWorkingDirectorySetting
        ? current.cwd
        : await awaitAbortable(resolveWorkingDirectory(settings.workingDirectory, true), signal);
    if (!cwd) throw new StartCancelledError();
    const remoteSettings = await this.prepareRemoteSettings(settings, signal);
    const launchSettings = withVerifiedRuntime(remoteSettings, runtime, environment, this.dshHome);
    // Reject process-affecting configuration while the healthy old service is
    // still running; a typo must not turn a restart into avoidable downtime.
    validateLaunchSettings(launchSettings);
    buildSpawnSpec(launchSettings, runtime.npxPath);
    this.throwIfCancelled(signal);
    const request: LaunchRequest = { settings: launchSettings, cwd, npxPath: runtime.npxPath };

    this.launchFingerprint = launchSettingsFingerprint(settings);
    this.launchedWorkingDirectorySetting = settings.workingDirectory;
    this.restartRequired = false;
    this.operationSnapshot = undefined;
    this.restartInProgress = true;
    try {
      await this.manager.stop();
      this.throwIfCancelled(signal);
      return await this.startWithRemotePortRetry(request, settings, runtime, environment, signal);
    } finally {
      this.restartInProgress = false;
      if (this.manager.getSnapshot().state === 'stopped') {
        this.panel.showOffline(
          signal.aborted ? 'DeepSeek Harness 重启已取消，服务已停止。' : undefined
        );
      }
    }
  }

  private async copyUrl(url = this.manager.getUrl()): Promise<void> {
    if (!url) {
      void vscode.window.showWarningMessage('DeepSeek Harness 尚未运行。');
      return;
    }
    try {
      const externalUrl = await this.resolveExternalUrl(url);
      await vscode.env.clipboard.writeText(externalUrl);
      void vscode.window.showInformationMessage('已复制 DeepSeek Harness 访问地址。');
    } catch (error) {
      void vscode.window.showErrorMessage(`复制地址失败：${messageOf(error)}`);
    }
  }

  private async refreshPanel(): Promise<void> {
    const snapshot = this.manager.getSnapshot();
    if (snapshot.ownership === 'external' && !(await this.manager.revalidateExternal())) return;
    try {
      await this.panel.refresh();
    } catch (error) {
      await this.showOpenError(error, 'editor');
    }
  }

  private async openPanelInBrowser(): Promise<void> {
    const url = this.panel.getUrl() ?? this.manager.getUrl();
    if (!url) return;
    const snapshot = this.manager.getSnapshot();
    if (snapshot.ownership === 'external' && !(await this.manager.revalidateExternal())) return;
    try {
      await this.present(url, 'browser');
    } catch (error) {
      await this.showOpenError(error, 'browser');
    }
  }

  private async onStatusClick(): Promise<void> {
    const snapshot = this.effectiveSnapshot();
    if (!vscode.workspace.isTrusted) {
      await this.openAt(readSettings().openLocation, true);
      return;
    }
    if (snapshot.state === 'starting') {
      const action = await vscode.window.showQuickPick(['取消当前操作', '显示输出'], {
        title: 'DeepSeek Harness 正在准备、启动或连接',
      });
      if (action === '取消当前操作') this.cancelLaunch();
      if (action === '显示输出') this.logger.show();
      return;
    }
    if (snapshot.state === 'stopping') {
      this.logger.show();
      return;
    }
    if (snapshot.state === 'error' && snapshot.ownership === 'managed') {
      const action = await vscode.window.showQuickPick(['再次停止服务', '显示输出'], {
        title: '上一个服务进程尚未确认退出',
      });
      if (action === '再次停止服务') await this.stopManaged();
      if (action === '显示输出') this.logger.show();
      return;
    }
    if (snapshot.state === 'error' && this.errorSource === 'external' && this.lastExternalUrl) {
      const action = await vscode.window.showQuickPick(['重新连接', '启动新服务', '显示扩展输出'], {
        title: snapshot.error ?? '外部 DeepSeek Harness 连接失败',
      });
      if (action === '重新连接') await this.connectTo(this.lastExternalUrl, true);
      if (action === '启动新服务') {
        this.lastExternalUrl = undefined;
        await this.openAt(readSettings().openLocation, true);
      }
      if (action === '显示扩展输出') this.logger.show();
      return;
    }
    if (snapshot.state === 'running' && this.restartRequired && snapshot.ownership === 'managed') {
      const action = await vscode.window.showQuickPick(['重启并应用设置', '打开', '显示输出'], {
        title: 'DeepSeek Harness Launcher 设置已更改',
      });
      if (action === '重启并应用设置') await this.restartManaged();
      if (action === '打开') await this.openAt(readSettings().openLocation, true);
      if (action === '显示输出') this.logger.show();
      return;
    }
    await this.openAt(readSettings().openLocation, true);
  }

  private cancelLaunch(): void {
    this.launchAbort?.abort();
    this.manager.cancelStart();
    if (this.operationSnapshot?.state === 'starting') {
      this.setOperation(undefined);
    }
  }

  private onStateChanged(snapshot: ServerSnapshot): void {
    const previous = this.lastSnapshot;
    this.lastSnapshot = snapshot;
    if (snapshot.state !== 'stopped') this.operationSnapshot = undefined;

    if (this.restartInProgress && ['stopping', 'stopped', 'starting'].includes(snapshot.state)) {
      this.panel.showOffline(
        'DeepSeek Harness 正在重启；服务就绪后此页面会自动恢复。',
        '正在重启'
      );
    } else if (snapshot.state === 'stopping') {
      this.panel.showOffline(
        'DeepSeek Harness 正在安全停止…',
        '正在停止'
      );
    } else if (snapshot.state === 'error') {
      this.panel.showOffline(snapshot.error ?? 'DeepSeek Harness 操作失败。', '错误');
    } else if (snapshot.state === 'stopped' && previous.state !== 'stopped') {
      this.panel.showOffline();
    }
    if (snapshot.state === 'running' && snapshot.url) {
      if (snapshot.ownership === 'external') this.lastExternalUrl = snapshot.url;
      if (this.panel.isOpen()) {
        void this.panel.updateUrl(snapshot.url).catch((error) => {
          this.logger.log(`无法更新 VS Code 内置界面：${messageOf(error)}`, 'info');
        });
      }
      this.recalculateRestartRequired();
    } else {
      this.restartRequired = false;
    }

    if (snapshot.state === 'error') {
      if (previous.ownership === 'external') this.errorSource = 'external';
      else if (snapshot.ownership === 'managed' || previous.ownership === 'managed') this.errorSource = 'managed';
    }

    void this.publish(this.effectiveSnapshot());

    if (!this.disposed && previous.state === 'running' && snapshot.state === 'error') {
      const external = previous.ownership === 'external';
      const actions = external ? ['重新连接'] : ['查看输出'];
      void vscode.window.showErrorMessage(snapshot.error ?? 'DeepSeek Harness 已停止', ...actions).then((choice) => {
        if (choice === '查看输出') this.logger.show();
        if (choice === '重新连接' && this.lastExternalUrl) void this.connectTo(this.lastExternalUrl, true);
      });
    }
  }

  private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration('vscode-dsh')) return;
    this.recalculateRestartRequired();
    void this.publish(this.effectiveSnapshot());
  }

  private recalculateRestartRequired(): void {
    const snapshot = this.manager.getSnapshot();
    this.restartRequired =
      snapshot.state === 'running' &&
      snapshot.ownership === 'managed' &&
      this.launchFingerprint !== undefined &&
      launchSettingsFingerprint(readSettings()) !== this.launchFingerprint;
  }

  private async prepareRemoteSettings(settings: DshSettings, signal: AbortSignal): Promise<DshSettings> {
    if (!vscode.env.remoteName) return settings;

    const port = settings.port === 0
      ? await awaitAbortable(findAvailableLoopbackPort(), signal)
      : settings.port;
    this.throwIfCancelled(signal);

    let externalUri: vscode.Uri;
    try {
      externalUri = await awaitAbortable(
        vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}`)),
        signal
      );
    } catch (error) {
      if (isCancellationError(error)) throw error;
      throw new Error(
        `无法准备 VS Code Remote 转发地址：${messageOf(error)}。` +
          '请检查端口转发权限后重试；扩展不会在 Host 信任名单未知时启动服务。'
      );
    }

    const hostname = safeHostname(externalUri);
    const authority = externalUri.authority;
    if (!authority || isLoopbackHostname(hostname) || hasTrustedAuthority(settings.webArgs, authority)) {
      return { ...settings, port };
    }

    this.logger.log(`已将 VS Code Remote 转发 authority 加入 DSH Host 信任名单：${authority}`, 'info');
    return {
      ...settings,
      port,
      webArgs: ['--trusted-host', authority, ...settings.webArgs],
    };
  }

  private async startWithRemotePortRetry(
    request: LaunchRequest,
    configuredSettings: DshSettings,
    runtime: NodeRuntime,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal
  ): Promise<StartResult> {
    try {
      return await this.manager.start(request);
    } catch (error) {
      const eligible = Boolean(vscode.env.remoteName) && configuredSettings.port === 0;
      let retryable = eligible && error instanceof PortConflictError;
      if (
        eligible &&
        !retryable &&
        /就绪前退出/.test(messageOf(error)) &&
        request.settings.port > 0
      ) {
        retryable = await awaitAbortable(isPortInUse(request.settings.port, 600, signal), signal);
      }
      if (!retryable) throw error;

      this.throwIfCancelled(signal);
      this.logger.log('Remote 自动端口在启动前被占用，正在重新分配并重试一次', 'info');
      const remoteSettings = await this.prepareRemoteSettings(configuredSettings, signal);
      const launchSettings = withVerifiedRuntime(remoteSettings, runtime, environment, this.dshHome);
      return this.manager.start({ ...request, settings: launchSettings });
    }
  }

  private async resolveExternalUrl(internalUrl: string): Promise<string> {
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(internalUrl));
    return uri.toString();
  }

  private ensureNodeRuntime(environment: NodeJS.ProcessEnv): Promise<NodeRuntime> {
    const key = `${environmentValue(environment, 'PATH') ?? ''}\0${environmentValue(environment, 'PATHEXT') ?? ''}`;
    let pending = this.runtimeCache.get(key);
    if (!pending) {
      pending = checkNodeRuntime(environment);
      this.runtimeCache.set(key, pending);
      pending.catch(() => {
        if (this.runtimeCache.get(key) === pending) this.runtimeCache.delete(key);
      });
    }
    return pending.then((runtime) => {
      this.logger.log(`使用 ${runtime.version}（npx: ${runtime.npxPath}）`, 'info');
      return runtime;
    });
  }

  private async ensureTrusted(
    interactive: boolean,
    resumeAfterTrust?: () => Promise<void>
  ): Promise<boolean> {
    if (vscode.workspace.isTrusted) return true;
    this.logger.log('工作区未受信任，拒绝启动或连接 DeepSeek Harness', 'info');
    if (!interactive) return false;
    const choice = await vscode.window.showWarningMessage(
      'DeepSeek Harness 能读写文件并执行命令。请仅在你信任的工作区中使用。',
      '管理工作区信任'
    );
    if (choice === '管理工作区信任') {
      const pending = resumeAfterTrust;
      this.pendingTrustAction = pending;
      try {
        await vscode.commands.executeCommand('workbench.trust.manage');
      } catch (error) {
        if (this.pendingTrustAction === pending) this.pendingTrustAction = undefined;
        throw error;
      }
      // Closing the Trust editor must not leave an action that can fire much
      // later when trust is granted for an unrelated reason.
      if (!vscode.workspace.isTrusted && this.pendingTrustAction === pending) {
        this.pendingTrustAction = undefined;
      }
    }
    return false;
  }

  private async onWorkspaceTrusted(): Promise<void> {
    await this.publish(this.effectiveSnapshot());
    const pending = this.pendingTrustAction;
    this.pendingTrustAction = undefined;
    if (pending) {
      const staleOperations = [
        ...(this.launchPromise ? [this.launchPromise] : []),
        ...this.openPromises.values(),
      ];
      void Promise.allSettled(staleOperations).then(() => {
        if (!this.disposed && vscode.workspace.isTrusted) void pending();
      });
      return;
    }
    const behavior = readSettings().startupBehavior;
    if (behavior !== 'manual') await this.startForStartup(behavior === 'startAndOpen');
  }

  private async showStartError(error: unknown): Promise<void> {
    if (isCancellationError(error)) {
      this.logger.log('操作已取消', 'info');
      return;
    }
    const choice = await vscode.window.showErrorMessage(messageOf(error), '查看输出', '打开设置');
    if (choice === '查看输出') this.logger.show();
    if (choice === '打开设置') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:joygqz.vscode-dsh');
    }
  }

  private async showOpenError(error: unknown, failedLocation: OpenLocation): Promise<void> {
    const fallbackLabel = failedLocation === 'browser' ? '在 VS Code 中打开' : '在浏览器中打开';
    const fallbackLocation: OpenLocation = failedLocation === 'browser' ? 'editor' : 'browser';
    const choice = await vscode.window.showErrorMessage(
      `服务正在运行，但打开界面失败：${messageOf(error)}`,
      fallbackLabel,
      '查看输出'
    );
    if (choice === fallbackLabel) {
      const url = this.manager.getUrl();
      if (url) {
        try {
          await this.present(url, fallbackLocation);
        } catch (retryError) {
          void vscode.window.showErrorMessage(`仍无法打开：${messageOf(retryError)}`);
        }
      }
    }
    if (choice === '查看输出') this.logger.show();
  }

  private effectiveSnapshot(): ServerSnapshot {
    return this.operationSnapshot ?? this.lastSnapshot;
  }

  private setOperation(snapshot: ServerSnapshot | undefined): void {
    this.operationSnapshot = snapshot;
    void this.publish(this.effectiveSnapshot());
  }

  private finishLaunch(promise: Promise<StartResult | undefined>, error?: unknown): void {
    if (this.launchPromise !== promise) return;
    this.clearLaunch(promise);
    if (!this.operationSnapshot) return;
    if (error && !isCancellationError(error) && this.manager.getSnapshot().state === 'stopped') {
      this.setOperation({ state: 'error', error: messageOf(error) });
    } else {
      // A restart preflight can fail while the old service is still healthy.
      this.setOperation(undefined);
    }
  }

  private clearLaunch(promise: Promise<StartResult | undefined>): void {
    if (this.launchPromise !== promise) return;
    this.launchPromise = undefined;
    this.launchAbort = undefined;
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted || this.disposed) throw new StartCancelledError();
  }

  private renderStatus(snapshot: ServerSnapshot): void {
    if (!vscode.workspace.isTrusted) {
      this.statusItem.text = '$(shield) DSH';
      this.statusItem.tooltip = '工作区未受信任\n点击了解并管理工作区信任';
      this.statusItem.accessibilityInformation = { label: 'DeepSeek Harness，需要信任工作区' };
      return;
    }

    switch (snapshot.state) {
      case 'running': {
        const port = snapshot.url ? portFromUrl(snapshot.url) : undefined;
        const external = snapshot.ownership === 'external';
        this.statusItem.text = `${external ? '$(link)' : '$(server)'} DSH${port ? `:${port}` : ''}${
          this.restartRequired ? '*' : ''
        }`;
        const lines = [
          external ? '已连接外部 DeepSeek Harness' : 'DeepSeek Harness 运行中',
          snapshot.url ?? '',
        ];
        if (snapshot.cwd) lines.push(`工作目录：${snapshot.cwd}`);
        if (external) lines.push('该服务不由本扩展停止或重启');
        if (this.restartRequired) lines.push('设置已更改；点击可重启并应用');
        else lines.push('点击打开');
        this.statusItem.tooltip = lines.join('\n');
        this.statusItem.accessibilityInformation = {
          label: external ? 'DeepSeek Harness，已连接外部服务' : 'DeepSeek Harness，运行中',
        };
        break;
      }
      case 'starting':
        this.statusItem.text = '$(sync~spin) DSH 处理中…';
        this.statusItem.tooltip = '正在检查环境、启动或连接 DeepSeek Harness\n点击可取消当前操作或查看输出';
        this.statusItem.accessibilityInformation = { label: 'DeepSeek Harness，操作进行中' };
        break;
      case 'stopping':
        this.statusItem.text = '$(sync~spin) DSH 停止中…';
        this.statusItem.tooltip = '正在安全停止 DeepSeek Harness\n点击查看输出';
        this.statusItem.accessibilityInformation = { label: 'DeepSeek Harness，停止中' };
        break;
      case 'error':
        this.statusItem.text = '$(error) DSH';
        this.statusItem.tooltip = `${snapshot.error ?? '操作失败'}\n点击查看恢复选项`;
        this.statusItem.accessibilityInformation = { label: 'DeepSeek Harness，发生错误' };
        break;
      default:
        this.statusItem.text = '$(server) DSH';
        this.statusItem.tooltip = 'DeepSeek Harness 未运行\n点击启动并打开';
        this.statusItem.accessibilityInformation = { label: 'DeepSeek Harness，未运行' };
    }
  }

  private publish(snapshot: ServerSnapshot): Promise<void> {
    this.renderStatus(snapshot);
    const values = {
      state: snapshot.state,
      managed: snapshot.ownership === 'managed',
      external: snapshot.ownership === 'external',
      hasUrl: Boolean(snapshot.url),
      restartRequired: this.restartRequired,
    };
    this.contextQueue = this.contextQueue
      .then(async () => {
        await Promise.all([
          vscode.commands.executeCommand('setContext', 'vscode-dsh.state', values.state),
          vscode.commands.executeCommand('setContext', 'vscode-dsh.managed', values.managed),
          vscode.commands.executeCommand('setContext', 'vscode-dsh.external', values.external),
          vscode.commands.executeCommand('setContext', 'vscode-dsh.hasUrl', values.hasUrl),
          vscode.commands.executeCommand('setContext', 'vscode-dsh.restartRequired', values.restartRequired),
        ]);
      })
      .catch((error) => this.logger.log(`无法更新命令状态：${messageOf(error)}`, 'info'));
    return this.contextQueue;
  }
}

function awaitAbortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new StartCancelledError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new StartCancelledError()));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function safeHostname(uri: vscode.Uri): string {
  try {
    return new URL(uri.toString()).hostname;
  } catch {
    return '';
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function hasTrustedAuthority(args: string[], authority: string): boolean {
  return args.some(
    (arg, index) =>
      arg === `--trusted-host=${authority}` ||
      (arg === '--trusted-host' && args[index + 1] === authority)
  );
}

function withVerifiedRuntime(
  settings: DshSettings,
  runtime: NodeRuntime,
  effectiveEnvironment: NodeJS.ProcessEnv,
  dshHome: string
): DshSettings {
  const configuredEnvironment = Object.fromEntries(
    Object.entries(mergeEnvironment({}, settings.environment)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  const configuredKey = environmentKey(configuredEnvironment, 'PATH');
  const inheritedKey = environmentKey(effectiveEnvironment, 'PATH');
  const pathKey = configuredKey ?? inheritedKey ?? 'PATH';
  const currentPath = environmentValue(effectiveEnvironment, 'PATH') ?? '';
  const runtimeDirectory = dirname(runtime.nodePath);
  const entries = currentPath.split(delimiter).filter(Boolean);
  const path = [runtimeDirectory, ...entries.filter((entry) => entry !== runtimeDirectory)].join(delimiter);
  const securedEnvironment = mergeEnvironment(configuredEnvironment, { DSH_HOME: dshHome });
  return {
    ...settings,
    environment: { ...securedEnvironment, [pathKey]: path } as Record<string, string>,
  };
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = environmentKey(environment, name);
  return key ? environment[key] : undefined;
}

function environmentKey(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== 'win32') {
    return Object.prototype.hasOwnProperty.call(environment, name) ? name : undefined;
  }
  return Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
