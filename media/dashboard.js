const vscode = acquireVsCodeApi();

let snapshot = {
  files: [],
  selectedFile: "",
  automationMode: "semi"
};

const elements = {
  repoLine: document.querySelector("#repoLine"),
  branchValue: document.querySelector("#branchValue"),
  upstreamValue: document.querySelector("#upstreamValue"),
  syncValue: document.querySelector("#syncValue"),
  changedValue: document.querySelector("#changedValue"),
  fileList: document.querySelector("#fileList"),
  selectedFile: document.querySelector("#selectedFile")
};

document.addEventListener("click", (event) => {
  const commandButton = event.target.closest("[data-command]");
  if (commandButton) {
    vscode.postMessage({
      type: "command",
      command: commandButton.dataset.command,
      path: snapshot.selectedFile || ""
    });
    return;
  }

  const modeButton = event.target.closest("[data-mode]");
  if (modeButton) {
    vscode.postMessage({
      type: "setMode",
      mode: modeButton.dataset.mode
    });
    return;
  }

  const fileButton = event.target.closest("[data-file]");
  if (fileButton) {
    vscode.postMessage({
      type: "selectFile",
      path: fileButton.dataset.file
    });
  }
});

window.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "snapshot") {
    return;
  }

  snapshot = event.data.snapshot;
  render();
});

function render() {
  elements.repoLine.textContent = snapshot.remote || snapshot.root || "No repository detected";
  elements.branchValue.textContent = snapshot.branch || "-";
  elements.upstreamValue.textContent = snapshot.upstream || "None";
  elements.syncValue.textContent = `${snapshot.ahead || 0} / ${snapshot.behind || 0}`;
  elements.changedValue.textContent = String(snapshot.files.length);
  elements.selectedFile.textContent = snapshot.selectedFile || "None";

  for (const button of document.querySelectorAll("[data-mode]")) {
    button.classList.toggle("active", button.dataset.mode === snapshot.automationMode);
  }

  renderFiles();
}

function renderFiles() {
  if (snapshot.files.length === 0) {
    elements.fileList.replaceChildren(emptyState());
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const file of snapshot.files) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-row";
    button.dataset.file = file.path;
    button.classList.toggle("active", file.path === snapshot.selectedFile);

    const status = document.createElement("span");
    status.className = `status-pill ${statusClass(file.statusLabel)}`;
    status.textContent = file.statusLabel;

    const name = document.createElement("span");
    name.className = "file-path";
    name.textContent = file.path;

    button.append(status, name);
    fragment.append(button);
  }

  elements.fileList.replaceChildren(fragment);
}

function emptyState() {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "No changed files";
  return empty;
}

function statusClass(status) {
  return String(status || "").toLowerCase();
}
