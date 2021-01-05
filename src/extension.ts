'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import { exec } from 'child_process';
import * as path from 'path';
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


function getCfg() {
    return vscode.workspace.getConfiguration()
}


function getHighlightMode() {
    return getCfg().get("python.coverageView.highlightMode");
}


function getPython() {
    return getCfg().get("python.pythonPath");
}


// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    let workspaceCache: { [id: string]: CoverageStats } = {};
    let decorCache: { [id: string]: vscode.TextEditorDecorationType } = {};
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
    // updateStatusBar(statusBar, "-", "-", "-");    
    runPytestCov(outputChannel, statusBar, workspaceCache);

}

// this method is called when your extension is deactivated
export function deactivate() {
}

function initCache(cache: { [id: string]: CoverageStats }, decors: { [id: string]: vscode.TextEditorDecorationType }) {
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
    cache: { [id: string]: CoverageStats },
    decors: { [id: string]: vscode.TextEditorDecorationType },
    relPath: string
) {
    if ('arcs' in jsonData) {
        //console.log("Arcs data found.")   
        Object.keys(jsonData.arcs).forEach(
            key => {
                let lines = new Set();
                let arcs: Array<any> = jsonData.arcs[key];
                arcs.forEach(
                    item => {
                        //get the nums as long as they are not nega
                        item.forEach(
                            (subitem: any) => {
                                if (subitem > 0) {
                                    lines.add(subitem);
                                }
                            }
                        );
                    }
                );
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
    const configuredFilename = vscode.workspace.getConfiguration().get("python.coveragepy.file");
    if (configuredFilename) {
        return "**/" + configuredFilename;
    }
    return "**/.coverage";
}

function updateCache(cache: { [id: string]: CoverageStats }, uri: vscode.Uri, decors: { [id: string]: vscode.TextEditorDecorationType }) {
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

function getIgnorableLines(editor: any) {
    //find lines where there are """ at start or end and add them to array of line numbers
    let ignorableLines: Array<number> = [];

    let pydoc_start: number = 0;
    let pydoc_detected: boolean = false;
    let pydoc_token: string = "";

    for (let i: number = 0; i < editor.document.lineCount; i++) {
        let line: string = editor.document.lineAt(i).text;
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

function updateOpenedEditors(cache: { [id: string]: CoverageStats }, decors: { [id: string]: vscode.TextEditorDecorationType }) {
    let editors = vscode.window.visibleTextEditors;
    if (editors.length === 0) {
        return;
    }
    let mode = getHighlightMode();

    editors.forEach((editor: any): void => {
        const filePath = editor.document.uri.path;
        if (filePath in decors) {
            decors[filePath].dispose();
            delete decors[filePath];
        }
        let ranges: Array<vscode.Range> = [];

        if (!(filePath in cache)) {
            return;
        }

        if (mode === MODE_MISSING) {
            let lines = cache[filePath].lines;
            lines.forEach(lineNo => {
                ranges.push(editor.document.lineAt(lineNo - 1).range);
            })
        } else {
            let ignorableSet = getIgnorableLines(editor)
            if (mode === MODE_COVERED) {
                let lines = cache[filePath].lines;
                lines.forEach(value => {
                    let lineNo = value - 1;
                    if (editor && !ignorableSet.has(lineNo)) {
                        ranges.push(editor.document.lineAt(lineNo).range);
                    }
                });
            } else {
                // uncovered mode
                let rlines = new Set(Array.from(Array(editor.document.lineCount).keys()));
                let lines = cache[filePath].lines;
                lines.forEach(value => {
                    rlines.delete(value - 1);
                });
                rlines.forEach(value => {
                    if (editor && !ignorableSet.has(value)) {
                        ranges.push(editor.document.lineAt(value).range);
                    }
                });
            }
        }

        let decor = getHighlightDecoration();
        editor.setDecorations(decor, ranges);
        decors[filePath] = decor;
    });

}


function getHighlightDecoration(): vscode.TextEditorDecorationType {
    let decor = vscode.window.createTextEditorDecorationType(
        { backgroundColor: vscode.workspace.getConfiguration().get("python.coverageView.highlight") }
    );
    return decor;
}

function runPytestCov(
    outputChannel: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem,
    cache: { [id: string]: CoverageStats },
) {

    let folders = vscode.workspace.workspaceFolders;
    if (folders === undefined) {
        outputChannel.append("No folders...");
        return;
    }
    for (let fldr of folders) {
        runPytestCovInFolder(outputChannel, statusBar, cache, fldr.uri.fsPath);
    }
}

function runPytestCovInFolder(
    outputChannel: vscode.OutputChannel,
    statusBar: vscode.StatusBarItem,
    cache: { [id: string]: CoverageStats },
    rootPath: string,
) {
    const python = getPython();

    let cmd = `cd ${rootPath} && ${python} -m pytest --cov=. `;

    exec(cmd, (err, stdout, stderr) => {
        if (err) {
            outputChannel.append(stderr);
            console.log(stderr);
            updateStatusBar(statusBar, "-", "-", "-");
            return;
        }
        let lines = stdout.split("\n");
        lines.forEach(line => {
            let items = line.replace(/\s\s+/g, ' ').split(' ');
            // length is 5 report contains Missing column when 'terms-missing' is switched on
            if (items.length >= 4 && items.length <= 5) {

                let percentCovered = items[3].trim();

                if (percentCovered.endsWith("%")) {
                    let key = `${rootPath}/${items[0]}`; //the filename
                    if (key in cache) {
                        let stats = cache[key];
                        stats.numLines = items[1];
                        stats.missedLines = items[2];
                        stats.percentCovered = percentCovered;
                    } else if (items[0] === "TOTAL") {
                        // TODO: report doesn't contain TOTAL if there is only one file
                        cache["TOTAL"] = new CoverageStats(new Array(0), items[1], items[2], percentCovered);
                    }

                }
            }
        });

        let activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            //get TOTAL path if any
            let total = "-";
            if ("TOTAL" in cache) {
                total = cache["TOTAL"].percentCovered;
            }
            let unixPath = activeEditor.document.uri.path;
            let fileStat = cache[unixPath];

            if (fileStat) {
                if (total !== '-') {
                    total = fileStat.percentCovered + "   /   " + total + (" (OVERALL)");
                } else {
                    total = fileStat.percentCovered;
                }
                updateStatusBar(statusBar, fileStat.numLines, fileStat.missedLines, total);
            }
        }

    });

}


function updateStatusBar(statusBar: vscode.StatusBarItem, total: string, misses: string, percent: string) {
    statusBar.hide();
    let mode = getHighlightMode();
    statusBar.text = `Highlight: ${mode} Current File --  Lines: ${total} Misses: "${misses} Cover: ${percent}`;
    statusBar.show();
}
