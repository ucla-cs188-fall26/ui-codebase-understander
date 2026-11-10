// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { openGraphPanel, resetLayout } from './panel';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "codeflow-visualizer" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('codeflow-visualizer.openGraph', () => {
		// The code you place here will be executed every time your command is executed
		// Open the graph panel for the workspace
		return openGraphPanel(context);
	});

	context.subscriptions.push(disposable);

	// Shown in the graph tab's toolbar and the Command Palette while the graph is open
	const resetCommand = vscode.commands.registerCommand('codeflow-visualizer.resetLayout', resetLayout);
	context.subscriptions.push(resetCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {}
