/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as vscode from 'vscode';

export class PythonTestCoverageTaskProvider implements vscode.TaskProvider {
    static PythonTestCoverageType = 'python-test-coverage';
    private pythonTestCoveragePromise: Thenable<vscode.Task[]> | undefined = undefined;

    constructor(workspaceRoot: string) {
        const pattern = path.join(workspaceRoot, 'PythonTestCoveragefile');
        const fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        fileWatcher.onDidChange(() => this.pythonTestCoveragePromise = undefined);
        fileWatcher.onDidCreate(() => this.pythonTestCoveragePromise = undefined);
        fileWatcher.onDidDelete(() => this.pythonTestCoveragePromise = undefined);
    }

    public provideTasks(): Thenable<vscode.Task[]> | undefined {
        if (!this.pythonTestCoveragePromise) {
            this.pythonTestCoveragePromise = getPythonTestCoverageTasks();
        }
        return this.pythonTestCoveragePromise;
    }

    public resolveTask(_task: vscode.Task): vscode.Task | undefined {
        const task = _task.definition.task;
        // A PythonTestCoverage task consists of a task and an optional file as specified in PythonTestCoverageTaskDefinition
        // Make sure that this looks like a PythonTestCoverage task by checking that there is a task.
        if (task) {
            // resolveTask requires that the same definition object be used.
            const definition: PythonTestCoverageTaskDefinition = <any>_task.definition;
            return new vscode.Task(definition, _task.scope ?? vscode.TaskScope.Workspace, definition.task, 'pythontestcoverage', new vscode.ShellExecution(`pythontestcoverage ${definition.task}`));
        }
        return undefined;
    }
}

function exists(file: string): Promise<boolean> {
    return new Promise<boolean>((resolve, _reject) => {
        fs.exists(file, (value) => {
            resolve(value);
        });
    });
}

function exec(command: string, options: cp.ExecOptions): Promise<{ stdout: string; stderr: string }> {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        cp.exec(command, options, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stdout, stderr });
            }
            resolve({ stdout, stderr });
        });
    });
}

let _channel: vscode.OutputChannel;
function getOutputChannel(): vscode.OutputChannel {
    if (!_channel) {
        _channel = vscode.window.createOutputChannel('PythonTestCoverage Auto Detection');
    }
    return _channel;
}

interface PythonTestCoverageTaskDefinition extends vscode.TaskDefinition {
    /**
     * The task name
     */
    task: string;

    /**
     * The pythontestcoverage file containing the task
     */
    file?: string;
}

const buildNames: string[] = ['build', 'compile', 'watch'];
function isBuildTask(name: string): boolean {
    for (const buildName of buildNames) {
        if (name.indexOf(buildName) !== -1) {
            return true;
        }
    }
    return false;
}

const testNames: string[] = ['test'];
function isTestTask(name: string): boolean {
    for (const testName of testNames) {
        if (name.indexOf(testName) !== -1) {
            return true;
        }
    }
    return false;
}

async function getPythonTestCoverageTasks(): Promise<vscode.Task[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const result: vscode.Task[] = [];
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return result;
    }
    for (const workspaceFolder of workspaceFolders) {
        const folderString = workspaceFolder.uri.fsPath;
        if (!folderString) {
            continue;
        }
        const pythontestcoverageFile = path.join(folderString, 'PythonTestCoveragefile');
        if (!await exists(pythontestcoverageFile)) {
            continue;
        }

        const commandLine = 'pythontestcoverage -AT -f PythonTestCoveragefile';
        try {
            const { stdout, stderr } = await exec(commandLine, { cwd: folderString });
            if (stderr && stderr.length > 0) {
                getOutputChannel().appendLine(stderr);
                getOutputChannel().show(true);
            }
            if (stdout) {
                const lines = stdout.split(/\r{0,1}\n/);
                for (const line of lines) {
                    if (line.length === 0) {
                        continue;
                    }
                    const regExp = /pythontestcoverage\s(.*)#/;
                    const matches = regExp.exec(line);
                    if (matches && matches.length === 2) {
                        const taskName = matches[1].trim();
                        const kind: PythonTestCoverageTaskDefinition = {
                            type: 'pythontestcoverage',
                            task: taskName
                        };
                        const task = new vscode.Task(kind, workspaceFolder, taskName, 'pythontestcoverage', new vscode.ShellExecution(`pythontestcoverage ${taskName}`));
                        result.push(task);
                        const lowerCaseLine = line.toLowerCase();
                        if (isBuildTask(lowerCaseLine)) {
                            task.group = vscode.TaskGroup.Build;
                        } else if (isTestTask(lowerCaseLine)) {
                            task.group = vscode.TaskGroup.Test;
                        }
                    }
                }
            }
        } catch (err) {
            const channel = getOutputChannel();
            if (err.stderr) {
                channel.appendLine(err.stderr);
            }
            if (err.stdout) {
                channel.appendLine(err.stdout);
            }
            channel.appendLine('Auto detecting pythontestcoverage tasks failed.');
            channel.show(true);
        }
    }
    return result;
}