import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const WL_MODE: vscode.DocumentSelector = { language: 'engplus', pattern: '**/*.epp' };
const TOKEN_REGEX = /[^;\t\s()]+/;

function file_format(line: number, doc: vscode.Uri): string {
    return `${doc.toString()}:${line+1}`;
}

interface ObjectTree {
    name: string;
    tp: string;
    child: undefined | ObjectTree;
}

interface Indent {
    howmuch: number;
    char: string;
}

interface ReadAble {
    getText(): string;
    fileName: string;
    uri: vscode.Uri;
}
type Def = (string|number|vscode.Uri)[];

let visits = [];
function get_defs(doc: ReadAble): Def[] {
    if (!visits.includes(doc.uri)) {
        let defs = doc.getText().split(/\r\n/).map((a,b)=>[a,b,doc.uri]);
        visits.push(doc.uri);
        for (const [statement, ..._] of defs.filter(e=>/import/i.test(e[0]+''))) {
            const p = path.join(path.dirname(doc.fileName), String(statement).substr(7)+'.epp');
            defs=defs.concat(get_defs({
                getText: ()=>fs.readFileSync(p).toString(),
                fileName: p,
                uri: (vscode.Uri.file(p))
            }));
        }
        return defs;
    }
    return [];
}

function indent_size(defs: Def[]): Indent|undefined {
    for (const _s of defs) {
        const s = String(_s[0]);
        if (!/^[\s\t]*;/.test(s) && s.trim().length>0 && /^[\s\t]+[a-zA-Z0-9\[\](){}_]/.test(s)) {
            return { howmuch: s.search(/[a-zA-Z0-9\[\](){}_]/), char: s[0] };
        }
    }
}

function trace_fn_info(defs: Def[], name: string, doc: vscode.TextDocument): string {
    const infos = defs.filter(e=>RegExp(`^[^;]*when [a-zA-Z0-9_]+ ${name.slice(0, name.length-1)}`, 'i').test(e[0]+''));
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
        return `In ${file_format(Number(e[1]), e[2] as vscode.Uri)}\n\n    ${e[0]}\n\n`;
    }).join('');
}

function trace(idx: number, ni: any, sp: string[]): ObjectTree {
    let ret = ni;
    if (sp[idx-1]=='having') {
        ret = (trace(idx-2, { tp: 'obj', name: sp[idx-2], child: ret }, sp));
    }
    if (sp[idx+1]=='in') {
        ret = (trace(idx+2, { tp: 'ns', name: sp[idx+2], child: ret }, sp));
    }
    return ret;
};

function stringify(e: ObjectTree): string {
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

function get_var_context(name: string, s: number, context: string[], doc: vscode.TextDocument, pos: vscode.Position, defs: Def[]): Def[] {
    const trace_object = trace(s, {tp:'root', name}, context);

    if (trace_object.tp == 'root') {
        const variables = defs.filter(e=>e[1]<=pos.line).filter(e=>RegExp(`^[^;]*(let|have|make) ([a-zA-Z0-9_]+ )*${name}( (is|as|:|->|with|for|of|about|to).*|(;.*)?)$`, 'i').test(e[0]+''));
        return variables;
    }
    else {
        let indent = indent_size(defs);
        let findcontext = defs;
        let onion = trace_object;
        while (onion.tp == 'ns') {
            let line = findcontext.filter(e=>RegExp(`^[^;]*name( )?space ${onion.name}$`, 'i').test(e[0]+''))[0];
            let lnnumber: number = Number(line[1]);
            let line_indents = String(line[0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch;
            let trimmed = findcontext.filter(e=>e[1]>lnnumber);
            findcontext = [];
            for (const s of trimmed) {
                findcontext.push(s);
                if (!RegExp(`^${indent.char.repeat(indent.howmuch*(line_indents+1))}`).test(s[0]+'')) break;
            }
            onion = onion.child;
        }

        if (onion.tp == 'root') {
            const variables = findcontext.filter(e=>RegExp(`^[^;]*(let|have|make) ([a-zA-Z0-9_]+ )*${onion.name}( (is|as|:|->|with|for|of|about|to).*|(\s*;.*)?)?$`, 'i').test(e[0]+''));
            return variables;
        }
        else if (onion.tp == 'obj') {
            let variables = findcontext.filter(e=>RegExp(`^[^;]*(let|have|make) ([a-zA-Z0-9_]+ )*${onion.name}( (is|as|:|->|with|for|of|about|to).*|(\s*;.*)?)?$`, 'i').test(e[0]+''));
            let statement = variables[variables.length-1][0] + '';
            let typename = statement.match(RegExp(`[a-z0-9A-Z_]+(?=( ${onion.name}))`))[0];
            if (/^(make|let|have)$/i.test(typename)) {
                return variables;
            }
            while (onion.tp == 'obj') {
                let line = defs.filter(e=>RegExp(`^[^;]*class [a-zA-Z0-9_]+ type ${typename}$`, 'i').test(e[0]+''));
                let lnnumber: number = Number(line[0][1]);
                let line_indents = String(line[0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch;
                let trimmed = defs.filter(e=>e[1]>lnnumber);
                findcontext = [];
                for (const s of trimmed) {
                    findcontext.push(s);
                    if (!RegExp(`^${indent.char.repeat(indent.howmuch*(line_indents+1))}`).test(s[0]+'')) break;
                }
                onion = onion.child;
                variables = findcontext.filter(e=>RegExp(`^[^;]*(has) ([a-zA-Z0-9_]+ )*${onion.name}( (is|as|:|->|with|for|of|about|to).*|(\s*;.*)?)?$`, 'i').test(e[0]+''));
                statement = variables[variables.length-1][0] + '';
                typename = statement.match(RegExp(`[a-z0-9A-Z_]+(?=( ${onion.name}))`))[0];
                if (/^(has)$/i.test(typename)) {
                    return variables;
                }
                else if (onion.tp == 'root') return variables;
            }
        }
    }
}

function definition(context: string, doc: vscode.TextDocument, pos: vscode.Position): string {
    if (/^[\s\t\r\n]$/.test(doc.getText(new vscode.Range(pos, new vscode.Position(pos.line, pos.character+1))))) return '';
    if (context.trim()[0] == ';') return '';
    const token_pos = doc.getWordRangeAtPosition(pos, TOKEN_REGEX);
    const name = doc.getText(token_pos);
    visits = [];
    const defs = get_defs(doc);
    const trimmed = context.trim();

    if (/^[a-z]+[:!=]$/i.test(name)) {
        return trace_fn_info(defs, name, doc);
    }
    else {
        if (/^(make|let|have|it|when|for|of|do|was|were|repeat|while|if|else|lib(rary)?|import|const(ant)?|static|true|false|plus|minus|and(and)?|or(or)?)$/i.test(name)) return `Keyword: \`${name}\``;
        if (/^(to|for|of|->|:|about|with)$/i.test(name)) return `Prep.: \`${name}\``;
        if (new RegExp(`^[^;]*(let|have|make) ([a-zA-Z0-9_]+ )*${name} [a-zA-Z0-9_]+( (is|as|:|->|with|for|of|about|to).*|(;.*)?)$`, 'i').test(context)) {
            const classes = defs.filter(e=>RegExp(`^class [a-zA-Z0-9_]+ type ${name}`, 'i').test(e[0]+''))[0];
            return `In ${file_format(Number(classes[1]), classes[2] as vscode.Uri)}\n\n    ${classes[0]}\n\n`;
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

            if (/^(to|do)$/i.test(sp[s-1])) {
                return trace_fn_info(defs, name, doc);
            }
            if (/^(was|were)$/i.test(sp[s+1])) {
                return trace_fn_info(defs, name, doc);
            }
            if (/^(->|with|for|:|of|about|to)$/i.test(sp[s+1])) {
                return trace_fn_info(defs, name, doc);
            }
            
            let candidates = get_var_context(name, s, sp, doc, pos, defs).map(e=>`In ${file_format(Number(e[1]), e[2] as vscode.Uri)}\n\n    ${e[0].toString().trim()}\n\n`);
            return candidates.join('');
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
        if (/^import/i.test(document.getText().split(/\r\n/)[position.line])) {
            return new Promise<vscode.Location>(e=>e(new vscode.Location(
                vscode.Uri.file((path.dirname(document.uri.fsPath) + '\\' + document.getText().split(/\r\n/)[position.line].substr(7)+'.epp')),
                new vscode.Position(0, 0)
            )));
        }

        const def = definition(document.getText().split(/\r\n/)[position.line], document, position);
        if (/^In/.test(def.split(/\r\n/)[0])) {
            let pos_info = def.split('\n')[0].slice(3).split(':');
            pos_info = `${pos_info.slice(0, pos_info.length-1).join(':')}#${pos_info[pos_info.length-1]}`.split('#');
            
            const line_text: string = document.getText().split(/\r\n/)[Number(pos_info[1])-1];
            const pos = new vscode.Position(Number(pos_info[1])-1, line_text.search(/[a-z]+( (is|as|:|->|with|for|of|about|to).*|(;.*)?)$/));
            const file = vscode.Uri.parse(pos_info[0]);
            return new Promise<vscode.Location>(e=>e(new vscode.Location(file, pos)));
        }
    }
}

class GoCompletionItemProvider implements vscode.CompletionItemProvider {
    public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Thenable<vscode.CompletionItem[]> {
        const context = document.getText().split(/\r\n/)[position.line];
        const sp = context.trim().split(/[\s\t]+/);
        visits = [];
        const defs = get_defs(document);
        let ret: vscode.CompletionItem[] = [];
        let s = context.substring(0, position.character).trim().split(/\s+/).length - 1;
        let indent = indent_size(defs);
        
        if (sp[s-1]=='that' || (s==0&&!/^(that|to|was|were|having|make|let|have|while|if|repeat)$/i.test(sp[s]))) {
            if (sp[s]=='it') {
                defs.filter(e=>RegExp(`when [a-zA-Z0-9_]+ [a-zA-Z0-9_]+`, 'i').test(e[0]+''))
                .filter(e=>{
                    const idts=String(e[0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch;
                    for (let i=Number(e[1])-1;i>=0;i--) {
                        if (String(defs[i][0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch < idts) {
                            if (/class/i.test(String(defs[i][0]))) {
                                return false;
                            }
                        }
                    }
                    return true;
                })
                .map(e=>String(e[0]).match(/(?<=(when [a-zA-Z0-9_]+ ))[a-zA-Z0-9_]+/i)[0])
                .filter(e=>e!='created')
                .map(e=>ret.push(new vscode.CompletionItem(e, vscode.CompletionItemKind.Method)));
            }
            else {
                const typename = String(defs.filter(e=>RegExp(`^[^;]*(let|have|make) ([a-zA-Z0-9_]+ )*${sp[s]}( (is|as|:|->|with|for|of|about|to).*|(\s*;.*)?)?$`, 'i').test(e[0]+''))[0][0]).match(RegExp(`[a-z0-9A-Z_]+(?=( ${sp[s]}))`))[0];
                const line = defs.filter(e=>RegExp(`^class [a-zA-Z0-9_]+ type ${typename}`, 'i').test(e[0]+''))[0][1];
                let line_indents = String(line[0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch;
                let trimmed = defs.filter(e=>e[1]>line);
                let findcontext: Def[] = [];
                for (const s of trimmed) {
                    findcontext.push(s);
                    if (!RegExp(`^${indent.char.repeat(indent.howmuch*(line_indents+1))}`).test(s[0]+'')) break;
                }
                findcontext.filter(e=>RegExp(`^[^;]*when [a-zA-Z0-9_]+ [a-zA-Z0-9_]+`, 'i').test(e[0]+''))
                .map(e=>String(e[0]).match(/(?<=(when [a-zA-Z0-9_]+ ))[a-zA-Z0-9_]+/i)[0])
                .filter(e=>e!='created')
                .map(e=>ret.push(new vscode.CompletionItem(e, vscode.CompletionItemKind.Method)));
            }
        }
        else if (/^(to|was|were)$/i.test(sp[s])) {
            defs.filter(e=>RegExp(`when [a-zA-Z0-9_]+ [a-zA-Z0-9_]+`, 'i').test(e[0]+''))
            .filter(e=>{
                const idts=String(e[0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch;
                for (let i=Number(e[1])-1;i>=0;i--) {
                    if (String(defs[i][0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch < idts) {
                        if (/class/i.test(String(defs[i][0]))) {
                            return false;
                        }
                    }
                }
                return true;
            })
            .map(e=>String(e[0]).match(/(?<=(when [a-zA-Z0-9_]+ ))[a-zA-Z0-9_]+/i)[0])
            .filter(e=>e!='created')
            .map(e=>ret.push(new vscode.CompletionItem(e, vscode.CompletionItemKind.Method)));
        }
        else if (/^(make|let|have)$/i.test(sp[s])) {
            defs.filter(e=>RegExp(`^class [a-zA-Z0-9_]+ type [a-zA-Z0-9_]+`, 'i').test(e[0]+''))
            .map(e=>String(e[0]).match(/(?<=type\s)[a-zA-Z0-9_]+/i)[0])
            .filter(e=>e!='created')
            .map(e=>ret.push(new vscode.CompletionItem(e, vscode.CompletionItemKind.Class)));
            ret.push(new vscode.CompletionItem('integer', vscode.CompletionItemKind.Keyword));
            ret.push(new vscode.CompletionItem('string', vscode.CompletionItemKind.Keyword));
            ret.push(new vscode.CompletionItem('constant', vscode.CompletionItemKind.Keyword));
        }
        else if (/^(having)$/.test(sp[s])) {
            const typename = String(defs.filter(e=>RegExp(`^[^;]*(let|have|make) ([a-zA-Z0-9_]+ )*${sp[s-1]}( (is|as|:|->|with|for|of|about|to).*|(\s*;.*)?)?$`, 'i').test(e[0]+''))[0][0]).match(RegExp(`[a-z0-9A-Z_]+(?=( ${sp[s-1]}))`))[0];
            const line = defs.filter(e=>RegExp(`^class [a-zA-Z0-9_]+ type ${typename}`, 'i').test(e[0]+''))[0][1];
            let line_indents = String(line[0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch;
            let trimmed = defs.filter(e=>e[1]>line);
            let findcontext: Def[] = [];
            for (const s of trimmed) {
                findcontext.push(s);
                if (!RegExp(`^${indent.char.repeat(indent.howmuch*(line_indents+1))}`).test(s[0]+'')) break;
            }
            findcontext.filter(e=>RegExp(`^[^;]*has ([a-zA-Z0-9_]+ )*[a-zA-Z0-9_]+`, 'i').test(e[0]+''))
            .map(e=>{
                const statement = String(e[0]).split(';')[0].split(/[\s\t]/);
                let at = 0;
                if ((at = statement.findIndex(e=>/^(->|:|as|with|for|is|about|to|of)$/i.test(e))-1) == -2) {
                    at = statement.length-1;
                }
                ret.push(new vscode.CompletionItem(statement[at], vscode.CompletionItemKind.Property))
            });
        }
        else if (/^(while|if|repeat|and|or|plus|minus|as|is|\(|[+\-*\/&,]|[a-zA-Z0-9_]+[=!:]|of|about|with|that|what)$/i.test(sp[s])) {
            let idts=context.search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch;
            let findcontext: Def[] = [];
            let line = 0;
            let isbreak=false;
            for (let i=position.line-1;i>=0;i--) {
                if (String(defs[i][0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch < idts) {
                    if (/when/i.test(String(defs[i][0]))) {
                        line = i;
                        idts = String(defs[i][0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch;
                        isbreak=true;
                    }
                }
                if (isbreak) break;
            }
            for (let i=line+1;i<defs.length;i++) {
                const spaces = String(defs[i][0]).search(/[a-zA-Z0-9\[\](){}_]/);
                if (spaces!=-1){
                    if (spaces/indent.howmuch <= idts) {
                        break;
                    }
                    else findcontext.push(defs[i]);
                }
            }
            
            findcontext.filter(e=>RegExp(`^[^;]*(let|have|make) ([a-zA-Z0-9_]+ )*[a-zA-Z0-9_]+( (is|as|:|->|with|for|of|about|to).*|(\s*;.*)?)?$`, 'i').test(e[0]+''))
            .map(e=>{
                const statement = String(e[0]).split(';')[0].split(/[\s\t]/);
                let at = 0;
                if ((at = statement.findIndex(e=>/^(->|:|as|with|for|is|about|to|of)$/i.test(e))-1) == -2) {
                    at = statement.length-1;
                }
                ret.push(new vscode.CompletionItem(statement[at], vscode.CompletionItemKind.Variable))
            });
            if (/^[wt]hat$/i.test(sp[s])) {
                ret.push(new vscode.CompletionItem('it', vscode.CompletionItemKind.Keyword));
            }
        }
        else if (/^(\)|[a-zA-Z0-9_]+|[0-9]+)$/i.test(sp[s])) {
            defs.filter(e=>RegExp(`when [a-zA-Z0-9_]+ [a-zA-Z0-9_]+`, 'i').test(e[0]+''))
            .filter(e=>{
                const idts=String(e[0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch;
                for (let i=Number(e[1])-1;i>=0;i--) {
                    if (String(defs[i][0]).search(/[a-zA-Z0-9\[\](){}_]/)/indent.howmuch < idts) {
                        if (/class/i.test(String(defs[i][0]))) {
                            return false;
                        }
                    }
                }
                return true;
            })
            .map(e=>String(e[0]).match(/(?<=(when [a-zA-Z0-9_]+ ))[a-zA-Z0-9_]+/i)[0])
            .filter(e=>e!='starts')
            .map(e=>{
                ret.push(new vscode.CompletionItem(`${e}!`, vscode.CompletionItemKind.Operator));
                ret.push(new vscode.CompletionItem(`${e}=`, vscode.CompletionItemKind.Operator));
            });
            ret.push(new vscode.CompletionItem(`is`, vscode.CompletionItemKind.Operator));
            ret.push(new vscode.CompletionItem(`as`, vscode.CompletionItemKind.Operator));
            ret.push(new vscode.CompletionItem(`or`, vscode.CompletionItemKind.Operator));
            ret.push(new vscode.CompletionItem(`and`, vscode.CompletionItemKind.Operator));
            ret.push(new vscode.CompletionItem(`plus`, vscode.CompletionItemKind.Operator));
            ret.push(new vscode.CompletionItem(`minus`, vscode.CompletionItemKind.Operator));

            ret.push(new vscode.CompletionItem(`do`, vscode.CompletionItemKind.Keyword));
            ret.push(new vscode.CompletionItem(`was`, vscode.CompletionItemKind.Keyword));
        }

        return new Promise(e=>e(ret));
    }
}

export function activate(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(
        vscode.languages.registerHoverProvider(
            WL_MODE, new GoHoverProvider()));
    ctx.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            WL_MODE, new GoDefinitionProvider()));
    ctx.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            WL_MODE, new GoCompletionItemProvider(), ' '));
}