import * as vscode from "vscode";

const WL_MODE: vscode.DocumentSelector = { language: 'engplus', pattern: '**/*.epp' };
const TOKEN_REGEX = /[^;\t\s()]+/;

function file_format(line: number, doc: vscode.TextDocument): string {
        return `${doc.fileName}:${line+1}`;
}

function definition(name: string, doc: vscode.TextDocument): string {
    const defs = doc.getText().split(/\r\n/).map((a,b)=>[a,b]);

    if (/^[a-z]+$/i.test(name)) {
        return defs.filter(e=>RegExp(`^[^;]*(let|have|make) ${name}( (is|as|:|->|with|for|of|about|to).*|(;.*)?)$`, 'i').test(e[0]+'')).map(e=>`In ${file_format(Number(e[1]), doc)}\n\n    ${e[0].toString().trim()}\n\n`).join('');
    }
    if (/^[a-z]+[:!=]$/i.test(name)) {
        const infos = defs.filter(e=>RegExp(`^when [a-z]+ ${name.slice(0, name.length-1)}`, 'i').test(e[0]+''));
        // return infos.join('');
        return infos.map(e=>{
            const infos = (e[0]+'').trim().replace(/,/g, ' , ').split(/\s+/).slice(2);
            let args = [];
            let sess = '';
            for (const i of args) {
                if (i==',') {
                    args.push(sess.split(' '));
                    sess = '';
                }
                else if (i=='returns') {
                    if (sess.length > 0) args.push(sess.split(' '));
                    sess = '';
                }
                else {
                    sess += i + ' ';
                }
            }
            return `In ${file_format(Number(e[1]), doc)}\n\n    ${e[0]}\n\n`;
        }).join('');
    }
}

class GoHoverProvider implements vscode.HoverProvider {
    public provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Thenable<vscode.Hover> {
        return new Promise(e=>e(
            new vscode.Hover(definition(document.getText(document.getWordRangeAtPosition(position, TOKEN_REGEX)), document))
        ));
    }
}

class GoDefinitionProvider implements vscode.DefinitionProvider {
    public provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Thenable<vscode.Location> {
        let pos_info = definition(document.getText(document.getWordRangeAtPosition(position, TOKEN_REGEX)), document).split('\n')[0].slice(3).split(':');
        pos_info = `${pos_info.slice(0, pos_info.length-1).join(':')}#${pos_info[pos_info.length-1]}`.split('#');
        const pos = new vscode.Position(Number(pos_info[1])-1, 0);
        const file = vscode.Uri.file(pos_info[0].replace(/%5C/g, '\\'));
        return new Promise(e=>e(new vscode.Location(file, pos)));
    }
}

export function activate(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(
        vscode.languages.registerHoverProvider(
            WL_MODE, new GoHoverProvider()));
    ctx.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            WL_MODE, new GoDefinitionProvider()));
}