# GitHub Code Manager

GitHub Code Manager is a VS Code extension for managing everyday code changes with clear Git controls, file history, restore actions, and manual/semi/full automation modes.

## Run Locally

Open this folder in VS Code and press `F5`.

In the Extension Development Host window, run:

```text
GitHub Code Manager Dashboard
```

## Package Locally

Create a local VSIX package:

```powershell
npm run deploy:local
```

Install the generated `.vsix` from the `dist` folder using VS Code's **Install from VSIX** command.

## Features

- View changed files.
- Pull, commit, push, branch, and open PR pages.
- Create, rename, delete, and open files.
- View file history.
- Compare and restore previous file versions.
- Choose manual, semi-automated, or fully automated workflows.

The browser prototype is still available through `index.html`, but the VS Code extension is the main product.
