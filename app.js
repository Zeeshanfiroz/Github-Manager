const STORAGE_KEY = "github-manager-config";

const els = {
  connectForm: document.querySelector("#connectForm"),
  tokenInput: document.querySelector("#tokenInput"),
  ownerInput: document.querySelector("#ownerInput"),
  repoInput: document.querySelector("#repoInput"),
  branchInput: document.querySelector("#branchInput"),
  refreshButton: document.querySelector("#refreshButton"),
  newBranchInput: document.querySelector("#newBranchInput"),
  createBranchButton: document.querySelector("#createBranchButton"),
  connectionState: document.querySelector("#connectionState"),
  fileSearch: document.querySelector("#fileSearch"),
  fileList: document.querySelector("#fileList"),
  fileCount: document.querySelector("#fileCount"),
  fileRowTemplate: document.querySelector("#fileRowTemplate"),
  pathInput: document.querySelector("#pathInput"),
  newFileButton: document.querySelector("#newFileButton"),
  saveButton: document.querySelector("#saveButton"),
  deleteButton: document.querySelector("#deleteButton"),
  editor: document.querySelector("#editor"),
  activeFileName: document.querySelector("#activeFileName"),
  activeFileDetails: document.querySelector("#activeFileDetails"),
  dirtyBadge: document.querySelector("#dirtyBadge"),
  commitMessageInput: document.querySelector("#commitMessageInput"),
  branchBadge: document.querySelector("#branchBadge"),
  statBranch: document.querySelector("#statBranch"),
  statFiles: document.querySelector("#statFiles"),
  statSelection: document.querySelector("#statSelection"),
  clearLogButton: document.querySelector("#clearLogButton"),
  activityLog: document.querySelector("#activityLog")
};

const state = {
  token: "",
  owner: "",
  repo: "",
  branch: "main",
  defaultBranch: "main",
  files: [],
  current: null,
  connected: false,
  busy: false
};

function init() {
  loadStoredConfig();
  bindEvents();
  syncControls();
  updateStats();
  log("Ready");
}

function bindEvents() {
  els.connectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await connect();
  });

  els.refreshButton.addEventListener("click", async () => {
    await refreshTree();
  });

  els.createBranchButton.addEventListener("click", async () => {
    await createBranch();
  });

  els.fileSearch.addEventListener("input", renderFileList);
  els.newFileButton.addEventListener("click", startNewFile);
  els.saveButton.addEventListener("click", saveCurrentFile);
  els.deleteButton.addEventListener("click", deleteCurrentFile);
  els.clearLogButton.addEventListener("click", () => {
    els.activityLog.replaceChildren();
  });

  els.editor.addEventListener("input", updateDirtyState);
  els.pathInput.addEventListener("input", () => {
    if (state.current) {
      state.current.path = normalizePath(els.pathInput.value);
      updateCurrentMeta();
      updateStats();
    }
  });
}

function loadStoredConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    els.tokenInput.value = saved.token || "";
    els.ownerInput.value = saved.owner || "";
    els.repoInput.value = saved.repo || "";
    els.branchInput.value = saved.branch || "main";
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function storeConfig() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      token: state.token,
      owner: state.owner,
      repo: state.repo,
      branch: state.branch
    })
  );
}

function readConfigFromForm() {
  state.token = els.tokenInput.value.trim();
  state.owner = els.ownerInput.value.trim();
  state.repo = els.repoInput.value.trim();
  state.branch = els.branchInput.value.trim() || "main";

  if (!state.token || !state.owner || !state.repo) {
    throw new Error("Token, owner, and repo are required.");
  }
}

async function connect() {
  try {
    readConfigFromForm();
    setBusy(true);
    log(`Connecting to ${state.owner}/${state.repo}`);

    const repo = await github(`/repos/${state.owner}/${state.repo}`);
    state.defaultBranch = repo.default_branch || "main";

    if (!els.branchInput.value.trim()) {
      state.branch = state.defaultBranch;
      els.branchInput.value = state.branch;
    }

    await github(`/repos/${state.owner}/${state.repo}/branches/${encodeSegment(state.branch)}`);
    storeConfig();
    setConnected(true);
    await refreshTree();
    log(`Connected to ${state.owner}/${state.repo}`, "success");
  } catch (error) {
    setConnected(false);
    reportError(error);
  } finally {
    setBusy(false);
  }
}

async function refreshTree() {
  if (!hasConnection()) {
    return;
  }

  try {
    setBusy(true);
    const tree = await github(
      `/repos/${state.owner}/${state.repo}/git/trees/${encodeSegment(state.branch)}?recursive=1`
    );
    state.files = (tree.tree || [])
      .filter((item) => item.type === "blob")
      .map((item) => ({
        path: item.path,
        sha: item.sha,
        size: item.size || 0
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    renderFileList();
    updateStats();
    log(`Loaded ${state.files.length} files`, "success");
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

async function loadFile(path) {
  if (!path || !hasConnection()) {
    return;
  }

  if (hasUnsavedChanges() && !confirm("Discard unsaved changes?")) {
    return;
  }

  try {
    setBusy(true);
    const file = await github(
      `/repos/${state.owner}/${state.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(state.branch)}`
    );

    if (file.type !== "file") {
      throw new Error("Only regular files can be opened.");
    }

    if (file.encoding !== "base64") {
      throw new Error(`Unsupported file encoding: ${file.encoding || "unknown"}`);
    }

    const content = decodeBase64(file.content || "");
    state.current = {
      path: file.path,
      sha: file.sha,
      originalPath: file.path,
      original: content,
      isNew: false
    };

    els.pathInput.value = file.path;
    els.editor.value = content;
    updateCurrentMeta();
    updateDirtyState();
    updateStats();
    renderFileList();
    log(`Opened ${file.path}`);
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

function startNewFile() {
  if (hasUnsavedChanges() && !confirm("Discard unsaved changes?")) {
    return;
  }

  state.current = {
    path: "",
    sha: null,
    originalPath: "",
    original: "",
    isNew: true
  };
  els.pathInput.value = "";
  els.editor.value = "";
  els.pathInput.focus();
  updateCurrentMeta();
  updateDirtyState();
  updateStats();
  renderFileList();
  log("New file");
}

async function saveCurrentFile() {
  if (!state.current) {
    return;
  }

  if (!hasConnection()) {
    log("Connect before saving", "error");
    return;
  }

  const path = normalizePath(els.pathInput.value);
  const message = els.commitMessageInput.value.trim() || defaultCommitMessage(path);

  if (!path) {
    log("File path is required", "error");
    els.pathInput.focus();
    return;
  }

  if (!message) {
    log("Commit message is required", "error");
    els.commitMessageInput.focus();
    return;
  }

  if (state.current.sha && state.current.originalPath !== path) {
    log("Rename by creating the new path, then delete the old file.", "error");
    return;
  }

  try {
    setBusy(true);
    const body = {
      message,
      content: encodeBase64(els.editor.value),
      branch: state.branch
    };

    if (state.current.sha) {
      body.sha = state.current.sha;
    }

    const result = await github(`/repos/${state.owner}/${state.repo}/contents/${encodePath(path)}`, {
      method: "PUT",
      body
    });

    state.current = {
      path,
      sha: result.content?.sha || state.current.sha,
      originalPath: path,
      original: els.editor.value,
      isNew: false
    };

    els.pathInput.value = path;
    await refreshTree();
    updateCurrentMeta();
    updateDirtyState();
    updateStats();
    log(`Committed ${path}`, "success");
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

async function deleteCurrentFile() {
  if (!state.current || !state.current.sha) {
    log("Select a committed file to delete", "error");
    return;
  }

  if (!hasConnection()) {
    return;
  }

  const path = state.current.originalPath;
  const message = els.commitMessageInput.value.trim() || `Delete ${path}`;

  if (!confirm(`Delete ${path}?`)) {
    return;
  }

  try {
    setBusy(true);
    await github(`/repos/${state.owner}/${state.repo}/contents/${encodePath(path)}`, {
      method: "DELETE",
      body: {
        message,
        sha: state.current.sha,
        branch: state.branch
      }
    });

    state.current = null;
    els.pathInput.value = "";
    els.editor.value = "";
    await refreshTree();
    updateCurrentMeta();
    updateDirtyState();
    updateStats();
    log(`Deleted ${path}`, "success");
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

async function createBranch() {
  const nextBranch = els.newBranchInput.value.trim();

  if (!hasConnection()) {
    log("Connect before creating a branch", "error");
    return;
  }

  if (!nextBranch) {
    log("Branch name is required", "error");
    els.newBranchInput.focus();
    return;
  }

  try {
    setBusy(true);
    const sourceRef = await github(
      `/repos/${state.owner}/${state.repo}/git/ref/heads/${encodePath(state.branch)}`
    );

    await github(`/repos/${state.owner}/${state.repo}/git/refs`, {
      method: "POST",
      body: {
        ref: `refs/heads/${nextBranch}`,
        sha: sourceRef.object.sha
      }
    });

    state.branch = nextBranch;
    els.branchInput.value = nextBranch;
    els.newBranchInput.value = "";
    storeConfig();
    await refreshTree();
    log(`Created branch ${nextBranch}`, "success");
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(data?.message || `${response.status} ${response.statusText}`);
  }

  return data;
}

function renderFileList() {
  const search = els.fileSearch.value.trim().toLowerCase();
  const selectedPath = state.current?.originalPath || state.current?.path || "";
  const filtered = state.files.filter((file) => file.path.toLowerCase().includes(search));
  const fragment = document.createDocumentFragment();

  for (const file of filtered) {
    const row = els.fileRowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.path = file.path;
    row.classList.toggle("active", file.path === selectedPath);
    row.querySelector(".file-type").textContent = fileExtension(file.path);
    row.querySelector(".file-path").textContent = file.path;
    row.querySelector(".file-size").textContent = formatBytes(file.size);
    row.title = file.path;
    row.addEventListener("click", () => loadFile(file.path));
    fragment.append(row);
  }

  els.fileList.replaceChildren(fragment);
  els.fileCount.textContent = filtered.length.toString();
  syncControls();
}

function updateCurrentMeta() {
  if (!state.current) {
    els.activeFileName.textContent = "No file selected";
    els.activeFileDetails.textContent = hasConnection() ? "Choose a file or create one" : "Connect to a repository";
    return;
  }

  const path = state.current.path || "Untitled";
  els.activeFileName.textContent = fileName(path);
  els.activeFileDetails.textContent = `${path} - ${lineCount(els.editor.value)} lines - ${formatBytes(byteLength(els.editor.value))}`;
}

function updateDirtyState() {
  const dirty = hasUnsavedChanges();
  els.dirtyBadge.textContent = dirty ? "Changed" : "Clean";
  els.dirtyBadge.classList.toggle("dirty", dirty);
  updateCurrentMeta();
}

function updateStats() {
  els.branchBadge.textContent = state.branch || "-";
  els.statBranch.textContent = state.branch || "-";
  els.statFiles.textContent = state.files.length.toString();
  els.statSelection.textContent = state.current?.path || "None";
}

function setConnected(connected) {
  state.connected = connected;
  els.connectionState.textContent = connected
    ? `${state.owner}/${state.repo}`
    : "Offline";
  syncControls();
  updateStats();
}

function syncControls() {
  const canUseRepo = state.connected && !state.busy;
  const submitButton = els.connectForm.querySelector("button[type='submit']");

  submitButton.disabled = state.busy;
  els.refreshButton.disabled = !canUseRepo;
  els.createBranchButton.disabled = !canUseRepo;
  els.newFileButton.disabled = !canUseRepo;
  els.saveButton.disabled = !canUseRepo || !state.current;
  els.deleteButton.disabled = !canUseRepo || !state.current?.sha;
  els.fileSearch.disabled = !canUseRepo;
  els.clearLogButton.disabled = state.busy;

  for (const row of els.fileList.querySelectorAll("button")) {
    row.disabled = !canUseRepo;
  }
}

function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  syncControls();
}

function hasConnection() {
  return state.connected && Boolean(state.token && state.owner && state.repo && state.branch);
}

function hasUnsavedChanges() {
  if (!state.current) {
    return false;
  }

  return (
    els.editor.value !== state.current.original ||
    normalizePath(els.pathInput.value) !== state.current.originalPath
  );
}

function reportError(error) {
  console.error(error);
  log(error.message || "Something went wrong", "error");
}

function log(message, tone = "info") {
  const item = document.createElement("li");
  item.className = tone;
  item.textContent = message;

  const stamp = document.createElement("time");
  stamp.dateTime = new Date().toISOString();
  stamp.textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  item.append(stamp);
  els.activityLog.prepend(item);
}

function encodeSegment(value) {
  return encodeURIComponent(value);
}

function encodePath(path) {
  return normalizePath(path).split("/").map(encodeURIComponent).join("/");
}

function normalizePath(path) {
  return path.trim().replace(/^\/+/, "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function fileName(path) {
  const parts = normalizePath(path).split("/");
  return parts[parts.length - 1] || path;
}

function fileExtension(path) {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");

  if (dot <= 0 || dot === name.length - 1) {
    return "{}";
  }

  return name.slice(dot + 1, dot + 4).toUpperCase();
}

function defaultCommitMessage(path) {
  return state.current?.isNew ? `Create ${path}` : `Update ${path}`;
}

function lineCount(value) {
  if (!value) {
    return 0;
  }

  return value.split("\n").length;
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function decodeBase64(value) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

init();
