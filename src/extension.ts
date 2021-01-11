'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
// import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { chdir } from 'process';
import * as vscode from 'vscode';
import { MODE_COVERED, MODE_MISSING } from './constants';


class CoverageStats {
    public lines: Array<any>;
    public numLines: string;
    public missedLines: string;
    public percentCovered: string;

    constructor(lines: Array<any>, numLines: string, missedLines: string, percentCovered: string) {
        this.lines = lines;
        this.numLines = numLines;
        this.missedLines = missedLines;
        this.percentCovered = percentCovered;
    }

}

type CoverageStatsCache = { [id: string]: CoverageStats };
type DecorationCache = { [id: string]: vscode.TextEditorDecorationType };


function getCfg() {
    return vscode.workspace.getConfiguration()
}


function getHighlightMode(): string {
    return String(getCfg().get("python.coverageView.highlightMode"));
}

function getCoverageCmd(): string {
    return String(getCfg().get("python.coveragepy.cmd"));
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    let workspaceCache: CoverageStatsCache = {};
    let decorCache: DecorationCache = {};
    let outputChannel = vscode.window.createOutputChannel("PyCov-Test");
    let statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    //initialize

    initCache(workspaceCache, decorCache);
    let covFileWatcher = vscode.workspace.createFileSystemWatcher(getCoverageFilePattern(), false, false, false);
    covFileWatcher.onDidChange((uri: any) => {
        //console.log("Coverage file changed");
        updateCache(workspaceCache, uri, decorCache);
    });

    covFileWatcher.onDidCreate((uri: any) => {
        console.log("Coverage file created");
        updateCache(workspaceCache, uri, decorCache);
    });

    //TODO: add delete handler
    vscode.window.onDidChangeActiveTextEditor((editor: any) => {
        let unixPath = editor.document.uri.path;
        if (editor && unixPath in workspaceCache) {
            updateOpenedEditors(workspaceCache, decorCache);
        }

        if (editor) {
            //get TOTAL fsPath if any
            let total = "-";
            if ("TOTAL" in workspaceCache) {
                total = workspaceCache["TOTAL"].percentCovered;
            }
            let fileStat = workspaceCache[unixPath];

            if (fileStat) {
                if (total !== '-') {
                    total = `${fileStat.percentCovered}  /  ${total}  (OVERALL)`;
                } else {
                    total = fileStat.percentCovered;
                }
                updateStatusBar(statusBar, fileStat.numLines, fileStat.missedLines, total);
            } else {
                updateStatusBar(statusBar);
            }
        }
    });

    vscode.workspace.onDidChangeTextDocument((ev: any) => {
        const changedFilePath = ev.document.uri.path;
        if (!changedFilePath.endsWith(".py")) {
            updateStatusBar(statusBar, "-", "-", "-");
            return;
        }
        const editor = vscode.window.activeTextEditor;

        if (editor) {
            if (editor.document.uri.path === changedFilePath) {
                if (editor && changedFilePath in decorCache) {
                    decorCache[changedFilePath].dispose();
                    delete decorCache[changedFilePath];
                }
            }
        }
        //remove from cache
        delete workspaceCache[changedFilePath];

    });

    vscode.workspace.onDidSaveTextDocument((doc: any) => {
        if (doc.fileName.endsWith("py")) {
            runPytestCov(outputChannel, statusBar, workspaceCache);
        }
    });

    //console.log('Congratulations, your extension "py-coverage-view" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    let disposable = vscode.commands.registerCommand('pycoveragedisplay.runPytestCov', () => {
        runPytestCov(outputChannel, statusBar, workspaceCache);
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(statusBar);
    context.subscriptions.push(outputChannel);

    //init status bar:
    updateStatusBar(statusBar, "-", "-", "-");
    runPytestCov(outputChannel, statusBar, workspaceCache);

}

// this method is called when your extension is deactivated
export function deactivate() {
}

function initCache(cache: CoverageStatsCache, decors: DecorationCache) {
    console.log("Init cache");
    vscode.workspace.findFiles(getCoverageFilePattern()).then(values => {
        values.forEach(value => {

            let content = fs.readFileSync(value.fsPath);
            let relPath = path.dirname(value.path);

            let x = content.indexOf("{");
            if (x >= 0) {
                let buffer = content.slice(x);
                let jsonData = JSON.parse(buffer.toString());
                processCoverageFileContent(jsonData, cache, decors, relPath);
            }
        });
    });
}

function processCoverageFileContent(
    jsonData: any,
    cache: CoverageStatsCache,
    decors: DecorationCache,
    relPath: string
) {
    if ('arcs' in jsonData) {
        //console.log("Arcs data found.")   
        Object.keys(jsonData.arcs).forEach(
            key => {
                let lines = new Set();
                let arcs: Array<any> = jsonData.arcs[key];
                arcs.forEach(item => {
                    //get the nums as long as they are not nega
                    item.forEach((subitem: any) => {
                        if (subitem > 0) {
                            lines.add(subitem);
                        }
                    });
                });
                if (key in cache) {
                    cache[key].lines = jsonData.lines[key];
                } else {
                    cache[key] = new CoverageStats(jsonData.lines[key], '-', '-', '-%');
                }

            }
        );
    } else if ('files' in jsonData) {
        let mode = getHighlightMode();
        let linesKey: string;
        switch (mode) {
            case MODE_COVERED:
                linesKey = "executed_lines"
                break;
            default:
                linesKey = "missing_lines";
                break;
        }

        Object.keys(jsonData.files).forEach(
            key => {
                let unixPath = path.isAbsolute(key) ? key : path.join(relPath, key);
                // TODO: find a better solution for replacing back slashes with forward slashes
                unixPath = unixPath.replace(/\\/gi, '/');

                let fileStat: any = jsonData.files[key];
                let lines: any = fileStat[linesKey];

                let summary = fileStat.summary ? fileStat.summary : null;
                let persentCovered, numLines, missedLines;

                if (summary) {
                    persentCovered = summary.percent_covered.toString() + '%';
                    numLines = summary.covered_lines + summary.missing_lines + summary.excluded_lines;
                    missedLines = summary.missing_lines;
                } else {
                    persentCovered = '-%';
                    numLines = missedLines = '-';
                }

                let stat = new CoverageStats(lines, numLines, missedLines, persentCovered);

                cache[unixPath] = stat;
            }
        );

    } else {
        Object.keys(jsonData.lines).forEach(
            key => {
                if (key in cache) {
                    cache[key].lines = jsonData.lines[key];
                } else {
                    cache[key] = new CoverageStats(jsonData.lines[key], '-', '-', '-%');
                }
            }
        );
    }
    updateOpenedEditors(cache, decors);
}


function getCoverageFilePattern(): string {
    const configuredFilename = getCfg().get("python.coveragepy.file");
    if (configuredFilename) {
        return "**/" + configuredFilename;
    }
    return "**/.coverage";
}

function updateCache(cache: CoverageStatsCache, uri: vscode.Uri, decors: DecorationCache) {
    console.log("Updating cache");
    let relPath = path.dirname(uri.path);

    fs.readFile(uri.fsPath, (err, data) => {
        if (err) {
            console.error(err);
            return;
        }

        //find enclosing coverage data {...}
        let x = data.indexOf("{");
        if (x >= 0) {
            let buffer = data.slice(x);
            let jsonData = JSON.parse(buffer.toString());
            processCoverageFileContent(jsonData, cache, decors, relPath);
        }
    });
    updateOpenedEditors(cache, decors);
}

function getIgnorableLines(document: vscode.TextDocument) {
    //find lines where there are """ at start or end and add them to array of line numbers
    let ignorableLines: Array<number> = [];

    let pydoc_start: number = 0;
    let pydoc_detected: boolean = false;
    let pydoc_token: string = "";

    for (let i: number = 0; i < document.lineCount; i++) {
        let line: string = document.lineAt(i).text;
        line = line.trim();
        console.log(i, line);
        if (line.length === 0) {
            ignorableLines.push(i);
            console.log("Adding ignorable: ", i);
            continue;
        }
        if (!pydoc_detected && line.startsWith("\"\"\"")) {
            pydoc_detected = true;
            pydoc_token = "\"\"\"";
            pydoc_start = i;
        } else if (!pydoc_detected && line.startsWith("'''")) {
            pydoc_detected = true;
            pydoc_token = "'''";
            pydoc_start = i;
        }

        if (pydoc_detected && (pydoc_start !== i || (pydoc_start === i && line.length > 3)) &&
            pydoc_token !== "" && line.endsWith(pydoc_token)) {
            ignorableLines.push(i);
            console.log("Adding ignorable: ", i);
            pydoc_detected = false;
            pydoc_token = "";
            continue;
        }

        if (pydoc_detected ||
            line.charAt(0) === "#" ||
            line === "pass" ||
            line === "else:" ||
            line.startsWith("def ") ||
            line.startsWith("class ")) {
            ignorableLines.push(i);
            console.log("Adding ignorable: ", i);
        }
    }

    return new Set(ignorableLines);
}

function updateOpenedEditors(cache: CoverageStatsCache, decors: DecorationCache) {
    const editors = vscode.window.visibleTextEditors;
    if (editors.length === 0) {
        return;
    }
    const mode = getHighlightMode();

    for (let editor of editors) {
        if (!editor || !editor.document) {
            continue
        }

        const document: vscode.TextDocument = editor.document;
        const filePath = document.uri.path;

        if (filePath in decors) {
            decors[filePath].dispose();
            delete decors[filePath];
        }

        if (!(filePath in cache)) {
            continue;
        }

        const decor = getHighlightDecoration();

        editor.setDecorations(
            decor, calcHighlightRanges(mode, cache[filePath], document)
        );
        decors[filePath] = decor;
    }
}


function calcHighlightRanges(
    mode: string, fileStat: CoverageStats, document: vscode.TextDocument
): Array<vscode.Range> {
    const lines = fileStat.lines;
    const ranges: Array<vscode.Range> = [];

    if (mode === MODE_MISSING) {
        lines.forEach(lineNo => {
            ranges.push(document.lineAt(lineNo - 1).range);
        });
    } else {
        const ignorableSet = getIgnorableLines(document);

        if (mode === MODE_COVERED) {
            lines.forEach(value => {
                let lineNo = value - 1;
                if (!ignorableSet.has(lineNo)) {
                    ranges.push(document.lineAt(lineNo).range);
                }
            });
        } else {
            // uncovered mode
            let rlines = new Set(Array.from(Array(document.lineCount).keys()));

            lines.forEach(value => {
                rlines.delete(value - 1);
            });
            rlines.forEach(value => {
                if (!ignorableSet.has(value)) {
                    ranges.push(document.lineAt(value).range);
                }
            });
        }
    }
    return ranges;
}

function getHighlightDecoration(): vscode.TextEditorDecorationType {
    let decor = vscode.window.createTextEditorDecorationType(
        { backgroundColor: getCfg().get("python.coverageView.highlight") }
    );
    return decor;
}

function runPytestCov(
    outputChannel: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem,
    cache: CoverageStatsCache,
) {

    let folders = vscode.workspace.workspaceFolders;
    if (folders === undefined) {
        outputChannel.append("No folders...");
        return;
    }
    // TODO: Fix possible side effects
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        // Run tests only for currently active editor
        const fldr = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (fldr) {
            runPytestCovInFolder(outputChannel, statusBar, cache, fldr);
        }
    }
}

function createTask(workspaceFolder: vscode.WorkspaceFolder, commandLine: string) {
    const taskName = "run-pytest";
    const definition: vscode.TaskDefinition = {
        type: "shell",
        task: taskName,
    }
    return new vscode.Task(
        definition,
        workspaceFolder,
        taskName,
        'shell',
        new vscode.ShellExecution(commandLine),
    );
}

function runPytestCovInFolder(
    outputChannel: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem,
    cache: CoverageStatsCache,
    workspaceFolder: vscode.WorkspaceFolder,
) {
    chdir(workspaceFolder.uri.fsPath);
    const cmd = getCoverageCmd();
    const task = createTask(workspaceFolder, cmd)

    vscode.tasks.executeTask(task);

    vscode.tasks.onDidEndTask(e => {
        if (e.execution.task == task) {
            const covJsonFile = "coverage.json"
            let doUpdate = false;

            if (fs.existsSync('.coverage')) {
                // Generate coverage.json if it doen't exist
                if (fs.existsSync(covJsonFile)) {
                    if (fs.statSync(covJsonFile).mtime > fs.statSync('.coverage').mtime) {
                        console.info('%s already exists', covJsonFile);
                    } else {
                        // coverage json only if coverage.json older .coverage
                        doUpdate = true;
                        console.info('%s exists but outdated', covJsonFile);
                    }
                }
                if (doUpdate) {
                    console.info("%s doesn't exist. Running coverage json command", covJsonFile)
                    vscode.tasks.executeTask(createTask(workspaceFolder, 'coverage json --include=*'));
                }
            } else {
                console.error(".coverage file doesn't exit")
            }
        }
    });
}


function updateStatusBar(
    statusBar: vscode.StatusBarItem,
    total: string = '-',
    misses: string = '-',
    percent: string = '-'
) {
    statusBar.hide();
    let mode = getHighlightMode();
    statusBar.text = `Highlight: ${mode} Current File -- Lines: ${total} Misses: ${misses} Cover: ${percent}`;
    statusBar.show();
}
