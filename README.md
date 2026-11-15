# Codeflow Visualizer

This project is a **VS Code extension**, not a web application. You develop it by
launching a second VS Code window called the **Extension Development Host**.

## Start development

1. Open this repository folder in VS Code:
   `/Users/Paul/Desktop/ui-codebase-understander`
2. Install dependencies once from the repository root:

   ```sh
   npm install
   ```

3. Press **F5** (or open **Run and Debug** and choose **Run Extension**).
4. VS Code runs the build task and opens a new **Extension Development Host**
   window.
5. In that new window, open the Command Palette with **Shift+Command+P**,
   select **Hello World**, and run **Hello World**.

The extension currently displays a “Hello World from codeflow-visualizer!”
notification. There is no `localhost` URL to open.

## Running the demo
- clone this project locally in visual studio code
- ensure that dependencies are installed ```npm install```
- click on **run and debug** button on the side
- a new window should pop up
- within the new window open a new folder of project that you want to inspect / explore
- cmd + P (access command palette) -> search for : code graph
- click on the code graph and a tab should open up within visual studio code with an interactive graph


## Development workflow

- Keep the Extension Development Host window open while testing.
- Edit files under [`src/`](./src/).
- The `watch` build task recompiles TypeScript and bundles the extension when
  files change.
- After changing extension code, reload the development host with
  **Developer: Reload Window** from the Command Palette.
- Stop the development session with **Shift+F5**.

## Useful commands

Run these from the repository root:

```sh
# Type-check, lint, and bundle
npm run compile

# Start TypeScript and esbuild watchers
npm run watch

# Run the extension tests
npm test
```

## Project layout

- [`src/extension.ts`](./src/extension.ts): extension activation and commands
- [`package.json`](./package.json): commands and npm scripts
- [`.vscode/launch.json`](./.vscode/launch.json): the **Run Extension** launch configuration
- [`.vscode/tasks.json`](./.vscode/tasks.json): the automatic watch/build tasks
