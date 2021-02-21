import * as vscode from "vscode";

const WL_MODE: vscode.DocumentSelector = { language: 'engplus', pattern: '**/*.epp' };
const TOKEN_REGEX = /[^;\t\s()]+/;

function file_format(line: number, doc: vscode.TextDocument): string {
    return `${doc.fileName}:${line+1}`;
}

interface ObjectTree {
    name: string;
    tp: string;
    child: undefined | ObjectTree;
}

interface indent {
    howmuch: number;
    char: string;
}

function indent_size(defs: (number|string)[][]): indent|undefined {
    for (const _s of defs) {
        const s = String(_s[0]);
        if (!/^[\s\t]*;/.test(s) && s.trim().length>0 && /^[\s\t]+[a-zA-Z0-9\[\](){}_]/.test(s)) {
            return { howmuch: s.search(/[a-zA-Z0-9\[\](){}_]/), char: s[0] };
        }
    }
}

function definition(context: string, doc: vscode.TextDocument, pos: vscode.Position): string {
    if (/^[\s\t\r\n]$/.test(doc.getText(new vscode.Range(pos, new vscode.Position(pos.line, pos.character+1))))) return '';
    if (context.trim()[0] == ';') return '';
    const token_pos = doc.getWordRangeAtPosition(pos, TOKEN_REGEX);
    const name = doc.getText(token_pos);
    const defs = doc.getText().split(/\r\n/).map((a,b)=>[a,b]);
    const trimmed = context.trim();

    if (/^[a-z]+[:!=]$/i.test(name)) {
        const infos = defs.filter(e=>RegExp(`^when [a-z]+ ${name.slice(0, name.length-1)}`, 'i').test(e[0]+''));
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
    else {
        if (/^(make|let|have|it|when|for|of|do|was|were|repeat|while|if|else|lib(rary)?|import|const(ant)?|static|true|false|plus|minus|and(and)?|or(or)?)$/i.test(name)) return `Keyword: \`${name}\``;
        if (/^(to|for|of|->|:|about|with)$/i.test(name)) return `Prep.: \`${name}\``;
        if (new RegExp(`^[^;]*(let|have|make) ([a-z]+ )*${name} [a-z]+( (is|as|:|->|with|for|of|about|to).*|(;.*)?)$`, 'i').test(context)) {
            const classes = defs.filter(e=>RegExp(`^class [a-z]+ type ${name}`, 'i').test(e[0]+''))[0];
            return `In ${file_format(Number(classes[1]), doc)}\n\n    ${classes[0]}\n\n`;
        }
        else {
            const sp = trimmed.split(/[\s\t]+/);
            let _pos = token_pos.start.character - context.search(/[a-zA-Z0-9\[\](){}_]/);
            let s = 0;
            for (let i=0;i<sp.length;i++) {
                if (_pos == s) {
                    s = i;
                    break;
                }
                s += 1 + sp[i].length;
            }
            
            const trace = (idx: number, ni: any): ObjectTree => {
                let ret = ni;
                if (sp[idx-1]=='having') {
                    ret = (trace(idx-2, { tp: 'obj', name: sp[idx-2], child: ret }));
                }
                if (sp[idx+1]=='in') {
                    ret = (trace(idx+2, { tp: 'ns', name: sp[idx+2], child: ret }));
                }
                return ret;
            };

            const stringify = (e: ObjectTree): string => {
                if (e.tp == 'root') {
                    return `${e.name}`;
                }
                if (e.tp == 'ns') {
                    return `namespace ${e.name} { ${stringify(e.child)} }`;
                }
                if (e.tp == 'obj') {
                    return `${e.name} { ${stringify(e.child)} }`;
                }
            };
            const trace_object = trace(s, {tp:'root', name});

            if (trace_object.tp == 'root') {
                const variables = defs.filter(e=>e[1]<=pos.line).filter(e=>RegExp(`^[^;]*(let|have|make) ([a-z]+ )*${name}( (is|as|:|->|with|for|of|about|to).*|(;.*)?)$`, 'i').test(e[0]+'')).map(e=>`In ${file_format(Number(e[1]), doc)}\n\n    ${e[0].toString().trim()}\n\n`);
                return variables[variables.length-1];
            }
            else {
                let indent = indent_size(defs);
                let findcontext = defs;
                let onion = trace_object;
                let idts = 0;
                while (onion.tp == 'ns') {
                    let line = findcontext.filter(e=>RegExp(`^${indent.char.repeat(indent.howmuch*(idts))}name( )?space ${onion.name}$`, 'i').test(e[0]+''))[0];
                    let lnnumber: number = Number(line[1]);
                    let line_indents = String(line[0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch;
                    let trimmed = findcontext.filter(e=>e[1]>lnnumber);
                    findcontext = [];
                    for (const s of trimmed) {
                        findcontext.push(s);
                        if (!RegExp(`^${indent.char.repeat(indent.howmuch*(line_indents+1))}`).test(s[0]+'')) break;
                    }
                    onion = onion.child;
                    idts++;
                }
                if (onion.tp == 'root') {
                    const variables = findcontext.filter(e=>RegExp(`^[^;]*(let|have|make) ([a-z]+ )*${name}( (is|as|:|->|with|for|of|about|to).*|(;.*)?)$`, 'i').test(e[0]+'')).map(e=>`In ${file_format(Number(e[1]), doc)}\n\n    ${e[0].toString().trim()}\n\n`);
                    return variables[variables.length-1];
                }
                return findcontext.map(e=>String(e[0])).join('\n');
            }
        }
    }
}

class GoHoverProvider implements vscode.HoverProvider {
    public provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Thenable<vscode.Hover> {
        return new Promise<vscode.Hover>(e=>e(
            new vscode.Hover(definition(document.getText().split(/\r\n/)[position.line], document, position))
        ));
    }
}

class GoDefinitionProvider implements vscode.DefinitionProvider {
    public provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Thenable<vscode.Location> {
        const def = definition(document.getText().split(/\r\n/)[position.line], document, position);
        if (/^In/.test(def.split(/\r\n/)[0])) {
            let pos_info = def.split('\n')[0].slice(3).split(':');
            pos_info = `${pos_info.slice(0, pos_info.length-1).join(':')}#${pos_info[pos_info.length-1]}`.split('#');
            
            const line_text: string = document.getText().split(/\r\n/)[Number(pos_info[1])-1];
            const pos = new vscode.Position(Number(pos_info[1])-1, line_text.search(/[a-z]+( (is|as|:|->|with|for|of|about|to).*|(;.*)?)$/));
            const file = document.uri;
            return new Promise<vscode.Location>(e=>e(new vscode.Location(file, pos)));
        }
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