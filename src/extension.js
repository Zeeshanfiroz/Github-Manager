const vscode = require("vscode");
const { execFile } = require("child_process");
const fs = require("fs/promises");
const path = require("path");

const HISTORY_SCHEME = "github-code-manager-history";
const MODES = new Set(["manual", "semi", "full"]);

function activate(context) {
  const manager = new CodeManager(context);
  manager.activate();
}

function deactivate() {}

class CodeManager {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("GitHub Code Manager");
    this.treeProvider = new ChangedFilesProvider(this);
    this.historyProvider = new GitHistoryDocumentProvider(this);
    this.dashboardPanel = null;
    this.selectedFile = null;
    this.automationMode = this.getInitialAutomationMode();
  }

  activate() {
    this.context.subscriptions.push(
      this.output,
      vscode.window.registerTreeDataProvider("githubCodeManager.changedFiles", this.treeProvider),
      vscode.workspace.registerTextDocumentContentProvider(HISTORY_SCHEME, this.historyProvider),
      vscode.commands.registerCommand("githubCodeManager.openDashboard", () => this.safe(() => this.openDashboard())),
      vscode.commands.registerCommand("githubCodeManager.showDashboard", () => this.safe(() => this.openDashboard())),
      vscode.commands.registerCommand("githubCodeManager.refresh", () => this.safe(() => this.refresh())),
      vscode.commands.registerCommand("githubCodeManager.pull", () => this.safe(() => this.pull())),
      vscode.commands.registerCommand("githubCodeManager.push", () => this.safe(() => this.push())),
      vscode.commands.registerCommand("githubCodeManager.commit", () => this.safe(() => this.commitChanges())),
      vscode.commands.registerCommand("githubCodeManager.createBranch", () => this.safe(() => this.createBranch())),
      vscode.commands.registerCommand("githubCodeManager.switchBranch", () => this.safe(() => this.switchBranch())),
      vscode.commands.registerCommand("githubCodeManager.openPullRequest", () => this.safe(() => this.openPullRequest())),
      vscode.commands.registerCommand("githubCodeManager.setOriginRemote", () => this.safe(() => this.setOriginRemote())),
      vscode.commands.registerCommand("githubCodeManager.createFile", () => this.safe(() => this.createFile())),
      vscode.commands.registerCommand("githubCodeManager.renameFile", (item) => this.safe(() => this.renameFile(this.pathFromArg(item)))),
      vscode.commands.registerCommand("githubCodeManager.deleteFile", (item) => this.safe(() => this.deleteFile(this.pathFromArg(item)))),
      vscode.commands.registerCommand("githubCodeManager.openFile", (item) => this.safe(() => this.openFile(this.pathFromArg(item)))),
      vscode.commands.registerCommand("githubCodeManager.viewHistory", (item) => this.safe(() => this.viewHistory(this.pathFromArg(item)))),
      vscode.commands.registerCommand("githubCodeManager.compareWithPrevious", (item) => this.safe(() => this.compareWithPrevious(this.pathFromArg(item)))),
      vscode.commands.registerCommand("githubCodeManager.restoreFileVersion", (item) => this.safe(() => this.restoreFileVersion(this.pathFromArg(item)))),
      vscode.commands.registerCommand("githubCodeManager.runAutomation", () => this.safe(() => this.runAutomation())),
      vscode.commands.registerCommand("githubCodeManager.setGitHubToken", () => this.safe(() => this.setGitHubToken())),
      vscode.commands.registerCommand("githubCodeManager.clearGitHubToken", () => this.safe(() => this.clearGitHubToken()))
    );

    this.refresh();
    this.openDashboardOnDevelopmentHost();
  }

  openDashboardOnDevelopmentHost() {
    if (this.context.extensionMode !== vscode.ExtensionMode.Development) {
      return;
    }

    setTimeout(() => {
      this.safe(async () => {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
          await this.openDashboard();
        }
      });
    }, 800);
  }

  getInitialAutomationMode() {
    const saved = this.context.workspaceState.get("automationMode");
    if (MODES.has(saved)) {
      return saved;
    }

    const configured = vscode.workspace
      .getConfiguration("githubCodeManager")
      .get("defaultAutomationMode", "semi");
    return MODES.has(configured) ? configured : "semi";
  }

  async safe(task) {
    try {
      return await task();
    } catch (error) {
      this.handleError(error);
      return undefined;
    }
  }

  handleError(error) {
    const message = error && error.message ? error.message : String(error);
    this.output.appendLine(message);
    vscode.window.showErrorMessage(message);
  }

  async openDashboard() {
    if (this.dashboardPanel) {
      this.dashboardPanel.reveal(vscode.ViewColumn.One);
      await this.postDashboardSnapshot();
      return;
    }

    this.dashboardPanel = vscode.window.createWebviewPanel(
      "githubCodeManager.dashboard",
      "GitHub Code Manager",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "media")
        ]
      }
    );

    this.dashboardPanel.webview.html = this.getDashboardHtml(this.dashboardPanel.webview);
    this.dashboardPanel.onDidDispose(() => {
      this.dashboardPanel = null;
    });

    this.dashboardPanel.webview.onDidReceiveMessage((message) => {
      this.safe(() => this.handleDashboardMessage(message));
    });

    await this.postDashboardSnapshot();
  }

  async handleDashboardMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "setMode" && MODES.has(message.mode)) {
      this.automationMode = message.mode;
      await this.context.workspaceState.update("automationMode", message.mode);
      await this.postDashboardSnapshot();
      return;
    }

    if (message.type === "selectFile") {
      this.selectedFile = normalizeGitPath(message.path || "");
      await this.postDashboardSnapshot();
      return;
    }

    if (message.type !== "command") {
      return;
    }

    const filePath = normalizeGitPath(message.path || this.selectedFile || "");
    const routes = {
      refresh: () => this.refresh(),
      pull: () => this.pull(),
      push: () => this.push(),
      commit: () => this.commitChanges(),
      createBranch: () => this.createBranch(),
      switchBranch: () => this.switchBranch(),
      openPullRequest: () => this.openPullRequest(),
      setOriginRemote: () => this.setOriginRemote(),
      createFile: () => this.createFile(),
      renameFile: () => this.renameFile(filePath),
      deleteFile: () => this.deleteFile(filePath),
      openFile: () => this.openFile(filePath),
      viewHistory: () => this.viewHistory(filePath),
      compareWithPrevious: () => this.compareWithPrevious(filePath),
      restoreFileVersion: () => this.restoreFileVersion(filePath),
      runAutomation: () => this.runAutomation(),
      setGitHubToken: () => this.setGitHubToken()
    };

    if (routes[message.command]) {
      await routes[message.command]();
    }
  }

  async refresh() {
    this.treeProvider.refresh();
    await this.postDashboardSnapshot();
  }

  async postDashboardSnapshot() {
    if (!this.dashboardPanel) {
      return;
    }

    const snapshot = await this.getSnapshot();
    this.dashboardPanel.webview.postMessage({
      type: "snapshot",
      snapshot
    });
  }

  async getSnapshot() {
    const root = this.getWorkspaceRoot();
    const status = await this.getStatus();
    const branch = await this.getBranch();
    const upstreamResult = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      allowFailure: true,
      silent: true
    });
    const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : "";
    const aheadBehind = upstream
      ? await this.getAheadBehind()
      : { ahead: 0, behind: 0 };
    const remote = await this.git(["remote", "get-url", "origin"], {
      allowFailure: true,
      silent: true
    });
    const lastCommit = await this.git(["log", "-1", "--pretty=format:%h%x09%s%x09%cr"], {
      allowFailure: true,
      silent: true
    });
    const hasToken = Boolean(await this.context.secrets.get("githubCodeManager.token"));

    return {
      root,
      branch,
      upstream,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      remote: remote.exitCode === 0 ? remote.stdout.trim() : "",
      lastCommit: lastCommit.exitCode === 0 ? lastCommit.stdout.trim() : "",
      files: status,
      selectedFile: this.selectedFile,
      automationMode: this.automationMode,
      hasToken
    };
  }

  getWorkspaceRoot() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (!folder) {
      throw new Error("Open a workspace folder before using GitHub Code Manager.");
    }
    return folder.uri.fsPath;
  }

  async git(args, options = {}) {
    const root = options.cwd || this.getWorkspaceRoot();
    const commandText = `git ${args.join(" ")}`;

    if (!options.silent) {
      this.output.appendLine(`> ${commandText}`);
    }

    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: root,
          windowsHide: true,
          maxBuffer: 20 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          const exitCode = error && typeof error.code === "number" ? error.code : 0;

          if (!options.silent) {
            if (stdout.trim()) {
              this.output.appendLine(stdout.trim());
            }
            if (stderr.trim()) {
              this.output.appendLine(stderr.trim());
            }
          }

          if (error && !options.allowFailure) {
            reject(new Error((stderr || stdout || error.message).trim()));
            return;
          }

          resolve({ stdout, stderr, exitCode });
        }
      );
    });
  }

  async getBranch() {
    const result = await this.git(["branch", "--show-current"], {
      allowFailure: true,
      silent: true
    });
    return result.stdout.trim() || "HEAD";
  }

  async getAheadBehind() {
    const result = await this.git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], {
      allowFailure: true,
      silent: true
    });

    if (result.exitCode !== 0) {
      return { ahead: 0, behind: 0 };
    }

    const [ahead, behind] = result.stdout.trim().split(/\s+/).map((value) => Number(value) || 0);
    return { ahead, behind };
  }

  async getStatus() {
    const result = await this.git(["status", "--porcelain=v1", "-uall"], {
      allowFailure: true,
      silent: true
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parsePorcelainStatus(result.stdout);
  }

  async pull() {
    const remote = await this.getOriginRemote();
    if (!remote) {
      await this.promptForOriginRemote("Pull needs an origin remote first.");
      return;
    }

    const upstream = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      allowFailure: true,
      silent: true
    });

    if (upstream.exitCode === 0) {
      await this.git(["pull", "--ff-only"]);
    } else {
      const branch = await this.getBranch();
      await this.git(["pull", "origin", branch, "--ff-only"]);
    }

    await this.refresh();
    vscode.window.showInformationMessage("Pulled latest changes.");
  }

  async push() {
    const branch = await this.getBranch();
    const hasCommits = await this.hasCommits();
    if (!hasCommits) {
      const action = await vscode.window.showWarningMessage(
        "There are no commits to push yet. Commit your changes first, then push.",
        "Commit Changes"
      );
      if (action === "Commit Changes") {
        await this.commitChanges();
      }
      return;
    }

    const remote = await this.getOriginRemote();
    if (!remote) {
      await this.promptForOriginRemote("Push needs an origin remote first.");
      return;
    }

    const upstream = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      allowFailure: true,
      silent: true
    });

    if (this.automationMode !== "manual") {
      const approved = await vscode.window.showWarningMessage(
        `Push branch ${branch}?`,
        { modal: true },
        "Push"
      );
      if (approved !== "Push") {
        return;
      }
    }

    if (upstream.exitCode === 0) {
      await this.git(["push"]);
    } else {
      await this.git(["push", "-u", "origin", branch]);
    }

    await this.refresh();
    vscode.window.showInformationMessage(`Pushed ${branch}.`);
  }

  async hasCommits() {
    const result = await this.git(["rev-parse", "--verify", "HEAD"], {
      allowFailure: true,
      silent: true
    });
    return result.exitCode === 0;
  }

  async getOriginRemote() {
    const result = await this.git(["remote", "get-url", "origin"], {
      allowFailure: true,
      silent: true
    });
    return result.exitCode === 0 ? result.stdout.trim() : "";
  }

  async promptForOriginRemote(message) {
    const action = await vscode.window.showWarningMessage(message, "Set Origin Remote");
    if (action === "Set Origin Remote") {
      await this.setOriginRemote();
    }
  }

  async setOriginRemote() {
    const current = await this.getOriginRemote();
    const remoteUrl = await vscode.window.showInputBox({
      title: "Set Origin Remote",
      prompt: "Enter your GitHub repository URL.",
      placeHolder: "https://github.com/owner/repo.git",
      value: current,
      ignoreFocusOut: true,
      validateInput: (value) => {
        const clean = value.trim();
        if (!clean) {
          return "Remote URL is required.";
        }
        if (/\s/.test(clean)) {
          return "Remote URL cannot contain spaces.";
        }
        return undefined;
      }
    });

    if (!remoteUrl) {
      return;
    }

    if (current) {
      await this.git(["remote", "set-url", "origin", remoteUrl.trim()]);
    } else {
      await this.git(["remote", "add", "origin", remoteUrl.trim()]);
    }

    await this.refresh();
    vscode.window.showInformationMessage("Origin remote saved.");
  }

  async commitChanges() {
    const files = await this.getStatus();
    if (files.length === 0) {
      vscode.window.showInformationMessage("No changes to commit.");
      return;
    }

    const suggested = generateCommitMessage(files);
    const message = await vscode.window.showInputBox({
      title: "Commit Changes",
      prompt: "Commit message",
      value: suggested,
      ignoreFocusOut: true
    });

    if (!message || !message.trim()) {
      return;
    }

    if (this.automationMode !== "manual") {
      const detail = files.map((file) => `${file.statusLabel}: ${file.path}`).join("\n");
      const approved = await vscode.window.showWarningMessage(
        `Commit ${files.length} changed file${files.length === 1 ? "" : "s"}?`,
        { modal: true, detail },
        "Commit"
      );
      if (approved !== "Commit") {
        return;
      }
    }

    await this.git(["add", "-A"]);
    await this.git(["commit", "-m", message.trim()]);
    await this.refresh();
    vscode.window.showInformationMessage("Committed changes.");
  }

  async createBranch() {
    const current = await this.getBranch();
    const defaultName = `codex/update-code`;
    const name = await vscode.window.showInputBox({
      title: "Create Branch",
      prompt: `Create a branch from ${current}`,
      value: defaultName,
      ignoreFocusOut: true,
      validateInput: (value) => {
        const clean = value.trim();
        if (!clean) {
          return "Branch name is required.";
        }
        if (/\s/.test(clean)) {
          return "Branch names cannot contain spaces.";
        }
        return undefined;
      }
    });

    if (!name) {
      return;
    }

    await this.git(["switch", "-c", name.trim()]);
    await this.refresh();
    vscode.window.showInformationMessage(`Created branch ${name.trim()}.`);
  }

  async switchBranch() {
    const result = await this.git(["branch", "--format=%(refname:short)"], {
      silent: true
    });
    const branches = result.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);

    const picked = await vscode.window.showQuickPick(branches, {
      title: "Switch Branch",
      placeHolder: "Choose a local branch"
    });

    if (!picked) {
      return;
    }

    await this.git(["switch", picked]);
    await this.refresh();
    vscode.window.showInformationMessage(`Switched to ${picked}.`);
  }

  async openPullRequest() {
    const remoteResult = await this.git(["remote", "get-url", "origin"], {
      allowFailure: true,
      silent: true
    });
    const repoUrl = remoteToGitHubUrl(remoteResult.stdout.trim());

    if (!repoUrl) {
      vscode.window.showWarningMessage("No GitHub origin remote found.");
      return;
    }

    const branch = await this.getBranch();
    const base = await this.getDefaultBranch();
    const url = `${repoUrl}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async getDefaultBranch() {
    const result = await this.git(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
      allowFailure: true,
      silent: true
    });

    if (result.exitCode === 0) {
      return result.stdout.trim().replace(/^origin\//, "") || "main";
    }

    return "main";
  }

  async createFile() {
    const relativePath = await vscode.window.showInputBox({
      title: "Create File",
      prompt: "New file path",
      placeHolder: "src/example.js",
      ignoreFocusOut: true,
      validateInput: (value) => validateRelativePath(value)
    });

    if (!relativePath) {
      return;
    }

    const filePath = normalizeGitPath(relativePath);
    const uri = this.uriForGitPath(filePath);

    try {
      await vscode.workspace.fs.stat(uri);
      vscode.window.showWarningMessage(`${filePath} already exists.`);
      return;
    } catch {
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await vscode.workspace.fs.writeFile(uri, Buffer.from("", "utf8"));
      await this.openFile(filePath);
      await this.refresh();
    }
  }

  async renameFile(filePath) {
    const currentPath = filePath || this.getActiveFilePath();
    if (!currentPath) {
      vscode.window.showWarningMessage("Select a file to rename.");
      return;
    }

    const nextPath = await vscode.window.showInputBox({
      title: "Rename File",
      prompt: "New file path",
      value: currentPath,
      ignoreFocusOut: true,
      validateInput: (value) => validateRelativePath(value)
    });

    if (!nextPath) {
      return;
    }

    const source = this.uriForGitPath(currentPath);
    const target = this.uriForGitPath(normalizeGitPath(nextPath));
    await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
    await vscode.workspace.fs.rename(source, target, { overwrite: false });
    await this.refresh();
    vscode.window.showInformationMessage(`Renamed ${currentPath}.`);
  }

  async deleteFile(filePath) {
    const currentPath = filePath || this.getActiveFilePath();
    if (!currentPath) {
      vscode.window.showWarningMessage("Select a file to delete.");
      return;
    }

    const approved = await vscode.window.showWarningMessage(
      `Delete ${currentPath}?`,
      {
        modal: true,
        detail: "The file will be removed from the workspace. You can restore committed versions from Git history."
      },
      "Delete"
    );

    if (approved !== "Delete") {
      return;
    }

    await vscode.workspace.fs.delete(this.uriForGitPath(currentPath), {
      recursive: false,
      useTrash: true
    });
    await this.refresh();
    vscode.window.showInformationMessage(`Deleted ${currentPath}.`);
  }

  async openFile(filePath) {
    const targetPath = filePath || this.getActiveFilePath();
    if (!targetPath) {
      vscode.window.showWarningMessage("Select a file to open.");
      return;
    }

    const uri = this.uriForGitPath(targetPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    this.selectedFile = targetPath;
    await this.postDashboardSnapshot();
  }

  async viewHistory(filePath) {
    const targetPath = filePath || this.getActiveFilePath();
    if (!targetPath) {
      vscode.window.showWarningMessage("Select a file to view history.");
      return;
    }

    const result = await this.git([
      "log",
      "--follow",
      "--date=relative",
      "--pretty=format:%h  %ad  %an  %s",
      "--",
      targetPath
    ], { silent: true, allowFailure: true });

    this.output.show(true);
    this.output.appendLine("");
    this.output.appendLine(`History for ${targetPath}`);
    this.output.appendLine(result.stdout.trim() || "No committed history found.");
  }

  async compareWithPrevious(filePath) {
    const targetPath = filePath || this.getActiveFilePath();
    if (!targetPath) {
      vscode.window.showWarningMessage("Select a file to compare.");
      return;
    }

    const commits = await this.getFileCommits(targetPath);
    if (commits.length < 2) {
      vscode.window.showInformationMessage("This file does not have a previous committed version.");
      return;
    }

    const previous = commits[1].hash;
    const oldUri = this.historyUri(previous, targetPath);
    const currentUri = this.uriForGitPath(targetPath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      oldUri,
      currentUri,
      `${targetPath}: ${commits[1].short} to working tree`
    );
  }

  async restoreFileVersion(filePath) {
    const targetPath = filePath || this.getActiveFilePath();
    if (!targetPath) {
      vscode.window.showWarningMessage("Select a file to restore.");
      return;
    }

    const commits = await this.getFileCommits(targetPath);
    if (commits.length === 0) {
      vscode.window.showInformationMessage("No committed versions found for this file.");
      return;
    }

    const picked = await vscode.window.showQuickPick(
      commits.map((commit) => ({
        label: `${commit.short}  ${commit.subject}`,
        description: commit.relativeDate,
        detail: commit.hash,
        commit
      })),
      {
        title: `Restore ${targetPath}`,
        placeHolder: "Choose the version to restore into your working tree"
      }
    );

    if (!picked) {
      return;
    }

    const approved = await vscode.window.showWarningMessage(
      `Restore ${targetPath} from ${picked.commit.short}?`,
      {
        modal: true,
        detail: "This replaces the working-tree file content. The change is not committed until you commit it."
      },
      "Restore"
    );

    if (approved !== "Restore") {
      return;
    }

    const content = await this.git(["show", `${picked.commit.hash}:${targetPath}`], {
      silent: true
    });
    const uri = this.uriForGitPath(targetPath);
    await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content.stdout, "utf8"));
    await this.openFile(targetPath);
    await this.refresh();
    vscode.window.showInformationMessage(`Restored ${targetPath} from ${picked.commit.short}.`);
  }

  async getFileCommits(filePath) {
    const result = await this.git([
      "log",
      "--follow",
      "--date=relative",
      "--format=%H%x09%h%x09%cr%x09%s",
      "--",
      filePath
    ], { silent: true, allowFailure: true });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return [];
    }

    return result.stdout.trim().split(/\r?\n/).map((line) => {
      const [hash, short, relativeDate, ...subjectParts] = line.split("\t");
      return {
        hash,
        short,
        relativeDate,
        subject: subjectParts.join("\t")
      };
    });
  }

  async runAutomation() {
    if (this.automationMode === "manual") {
      await this.openDashboard();
      vscode.window.showInformationMessage("Manual mode is active. Use the dashboard actions one by one.");
      return;
    }

    const files = await this.getStatus();
    if (files.length === 0) {
      vscode.window.showInformationMessage("No changes to automate.");
      return;
    }

    const remote = await this.getOriginRemote();
    if (!remote) {
      await this.promptForOriginRemote("Automation needs an origin remote before it can push.");
      return;
    }

    const branch = await this.getBranch();
    const hasCommits = await this.hasCommits();
    const shouldCreateBranch = hasCommits && (branch === "main" || branch === "master");
    const nextBranch = shouldCreateBranch ? `codex/auto-${timestampForBranch()}` : branch;
    const message = generateCommitMessage(files);
    const plan = [
      shouldCreateBranch ? `Create branch ${nextBranch}` : `Use branch ${branch}`,
      `Commit ${files.length} changed file${files.length === 1 ? "" : "s"} with "${message}"`,
      `Push ${nextBranch} to origin`,
      "Open a pull request page"
    ];

    const approved = await vscode.window.showWarningMessage(
      this.automationMode === "full" ? "Run full automation?" : "Run suggested automation?",
      {
        modal: true,
        detail: plan.join("\n")
      },
      "Run"
    );

    if (approved !== "Run") {
      return;
    }

    if (shouldCreateBranch) {
      await this.git(["switch", "-c", nextBranch]);
    }

    await this.git(["add", "-A"]);
    await this.git(["commit", "-m", message]);
    await this.git(["push", "-u", "origin", nextBranch]);
    await this.refresh();
    await this.openPullRequest();
    vscode.window.showInformationMessage("Automation complete.");
  }

  async setGitHubToken() {
    const token = await vscode.window.showInputBox({
      title: "Set GitHub Token",
      prompt: "Token is stored in VS Code SecretStorage. Fine-grained tokens should include repository Contents permissions.",
      password: true,
      ignoreFocusOut: true
    });

    if (!token) {
      return;
    }

    await this.context.secrets.store("githubCodeManager.token", token.trim());
    await this.postDashboardSnapshot();
    vscode.window.showInformationMessage("GitHub token saved.");
  }

  async clearGitHubToken() {
    await this.context.secrets.delete("githubCodeManager.token");
    await this.postDashboardSnapshot();
    vscode.window.showInformationMessage("GitHub token cleared.");
  }

  pathFromArg(item) {
    if (typeof item === "string") {
      return normalizeGitPath(item);
    }
    if (item && typeof item.filePath === "string") {
      return normalizeGitPath(item.filePath);
    }
    return this.selectedFile || this.getActiveFilePath();
  }

  getActiveFilePath() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return "";
    }

    return this.relativeGitPath(editor.document.uri.fsPath);
  }

  relativeGitPath(fileSystemPath) {
    const root = this.getWorkspaceRoot();
    const relative = path.relative(root, fileSystemPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return "";
    }
    return normalizeGitPath(relative);
  }

  uriForGitPath(filePath) {
    const root = this.getWorkspaceRoot();
    const parts = normalizeGitPath(filePath).split("/").filter(Boolean);
    return vscode.Uri.file(path.join(root, ...parts));
  }

  historyUri(ref, filePath) {
    const query = new URLSearchParams({
      root: this.getWorkspaceRoot(),
      ref,
      path: normalizeGitPath(filePath)
    });
    return vscode.Uri.from({
      scheme: HISTORY_SCHEME,
      authority: "version",
      path: `/${path.basename(filePath)}`,
      query: query.toString()
    });
  }

  getDashboardHtml(webview) {
    const nonce = randomNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "dashboard.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "dashboard.js"));

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>GitHub Code Manager</title>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div>
          <p class="eyebrow">Workspace</p>
          <h1>GitHub Code Manager</h1>
          <p id="repoLine">Loading repository...</p>
        </div>
        <button data-command="refresh" class="icon-button" title="Refresh">Refresh</button>
      </section>

      <section class="mode-strip" aria-label="Automation mode">
        <button data-mode="manual" class="mode-card" type="button">
          <strong>Manual</strong>
          <span>You approve every action.</span>
        </button>
        <button data-mode="semi" class="mode-card" type="button">
          <strong>Semi</strong>
          <span>Suggested plan, then approval.</span>
        </button>
        <button data-mode="full" class="mode-card" type="button">
          <strong>Full</strong>
          <span>Branch, commit, push, PR page.</span>
        </button>
      </section>

      <section class="stats" aria-label="Repository stats">
        <div><span>Branch</span><strong id="branchValue">-</strong></div>
        <div><span>Upstream</span><strong id="upstreamValue">-</strong></div>
        <div><span>Ahead / Behind</span><strong id="syncValue">0 / 0</strong></div>
        <div><span>Changed Files</span><strong id="changedValue">0</strong></div>
      </section>

      <section class="actions" aria-label="Repository actions">
        <button data-command="pull">Pull</button>
        <button data-command="commit">Commit</button>
        <button data-command="push">Push</button>
        <button data-command="createBranch">New Branch</button>
        <button data-command="switchBranch">Switch</button>
        <button data-command="setOriginRemote">Remote</button>
        <button data-command="openPullRequest">PR</button>
        <button data-command="runAutomation" class="primary">Run Automation</button>
      </section>

      <section class="work-area">
        <div class="files-panel">
          <div class="section-head">
            <h2>Changed Files</h2>
            <button data-command="createFile">New File</button>
          </div>
          <div id="fileList" class="file-list"></div>
        </div>

        <div class="details-panel">
          <div class="section-head">
            <h2>Selected File</h2>
            <span id="selectedFile">None</span>
          </div>
          <div class="file-actions">
            <button data-command="openFile">Open</button>
            <button data-command="viewHistory">History</button>
            <button data-command="compareWithPrevious">Compare</button>
            <button data-command="restoreFileVersion">Restore</button>
            <button data-command="renameFile">Rename</button>
            <button data-command="deleteFile" class="danger">Delete</button>
          </div>
          <div class="notes">
            <h3>Automation Guardrails</h3>
            <p>Full automation creates a branch when you are on main or master, commits current changes, pushes the branch, and opens the pull request page.</p>
            <p>Deletes and restores still ask for confirmation because they change file content.</p>
          </div>
        </div>
      </section>
    </main>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

class ChangedFilesProvider {
  constructor(manager) {
    this.manager = manager;
    this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  }

  refresh() {
    this.onDidChangeTreeDataEmitter.fire();
  }

  async getChildren() {
    return this.manager.getStatus();
  }

  getTreeItem(item) {
    const treeItem = new vscode.TreeItem(item.path, vscode.TreeItemCollapsibleState.None);
    treeItem.description = item.statusLabel;
    treeItem.tooltip = `${item.statusLabel}: ${item.path}`;
    treeItem.contextValue = "changedFile";
    treeItem.filePath = item.path;
    treeItem.command = {
      command: "githubCodeManager.openFile",
      title: "Open File",
      arguments: [item]
    };
    treeItem.iconPath = new vscode.ThemeIcon(iconForStatus(item.status));
    return treeItem;
  }
}

class GitHistoryDocumentProvider {
  constructor(manager) {
    this.manager = manager;
  }

  async provideTextDocumentContent(uri) {
    const query = new URLSearchParams(uri.query);
    const root = query.get("root");
    const ref = query.get("ref");
    const filePath = query.get("path");

    if (!root || !ref || !filePath) {
      return "";
    }

    const result = await this.manager.git(["show", `${ref}:${filePath}`], {
      cwd: root,
      silent: true,
      allowFailure: true
    });
    return result.stdout || result.stderr || "";
  }
}

function parsePorcelainStatus(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      let filePath = line.slice(3).trim();
      let originalPath = "";

      if (filePath.includes(" -> ")) {
        const parts = filePath.split(" -> ");
        originalPath = unquoteGitPath(parts[0]);
        filePath = parts[1];
      }

      filePath = unquoteGitPath(filePath);
      const normalizedStatus = status.replace(/\s/g, "");
      return {
        status: normalizedStatus || status.trim() || "?",
        statusLabel: statusLabel(status),
        path: normalizeGitPath(filePath),
        originalPath: normalizeGitPath(originalPath)
      };
    });
}

function statusLabel(status) {
  if (status.includes("R")) {
    return "Renamed";
  }
  if (status.includes("A") || status.includes("?")) {
    return "Added";
  }
  if (status.includes("D")) {
    return "Deleted";
  }
  if (status.includes("U")) {
    return "Conflict";
  }
  return "Modified";
}

function iconForStatus(status) {
  if (status.includes("D")) {
    return "trash";
  }
  if (status.includes("A") || status.includes("?")) {
    return "add";
  }
  if (status.includes("R")) {
    return "replace";
  }
  if (status.includes("U")) {
    return "warning";
  }
  return "edit";
}

function generateCommitMessage(files) {
  if (files.length === 1) {
    const file = files[0];
    if (file.statusLabel === "Added") {
      return `Create ${file.path}`;
    }
    if (file.statusLabel === "Deleted") {
      return `Delete ${file.path}`;
    }
    if (file.statusLabel === "Renamed") {
      return `Rename ${file.path}`;
    }
    return `Update ${file.path}`;
  }

  const added = files.filter((file) => file.statusLabel === "Added").length;
  const deleted = files.filter((file) => file.statusLabel === "Deleted").length;
  const modified = files.length - added - deleted;
  const parts = [];

  if (modified > 0) {
    parts.push(`${modified} updated`);
  }
  if (added > 0) {
    parts.push(`${added} added`);
  }
  if (deleted > 0) {
    parts.push(`${deleted} deleted`);
  }

  return `Update code files (${parts.join(", ")})`;
}

function validateRelativePath(value) {
  const clean = normalizeGitPath(value || "");
  if (!clean) {
    return "File path is required.";
  }
  if (clean.startsWith("../") || clean.includes("/../") || path.isAbsolute(clean)) {
    return "File path must stay inside the workspace.";
  }
  return undefined;
}

function normalizeGitPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function unquoteGitPath(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function remoteToGitHubUrl(remote) {
  if (!remote) {
    return "";
  }

  const sshMatch = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, "")}`;
  }

  const httpsMatch = remote.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/, "")}`;
  }

  return "";
}

function timestampForBranch() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes())
  ].join("");
}

function randomNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

module.exports = {
  activate,
  deactivate
};
