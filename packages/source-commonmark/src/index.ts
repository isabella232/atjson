import Document, { Annotation } from '@atjson/document';
import * as entities from 'entities';
import * as MarkdownIt from 'markdown-it';
import schema from './schema';

export { default as schema } from './schema';

interface Attributes {
  [key: string]: string;
}

type Tuple = [string, string];

function getAttributes(token: MarkdownIt.Token): Attributes {
  return (token.attrs || []).reduce((attributes: Attributes, attribute: Tuple) => {
    attributes[attribute[0]] = attribute[1];
    return attributes;
  }, {});
}

interface Node {
  name: string;
  open?: MarkdownIt.Token;
  close?: MarkdownIt.Token;
  value?: MarkdownIt.Token | string;
  parent?: Node;
  children?: (Node | string)[];
}

function toTree(tokens: MarkdownIt.Token[], rootNode: Node) {
  let currentNode = rootNode;
  tokens.forEach(token => {
    // Ignore softbreak as per markdown-it defaults
    if (token.tag === 'br' && token.type === 'softbreak') {
      currentNode.children.push({
        name: 'text',
        value: '\n',
        parent: currentNode
      });
    } else if (token.type === 'text') {
      currentNode.children.push({
        name: 'text',
        value: token.content,
        parent: currentNode
      });
    } else if (token.type === 'inline') {
      toTree(token.children, currentNode);
    } else if (token.children && token.children.length > 0) {
      let node = {
        name: token.type,
        open: token,
        parent: currentNode,
        children: []
      };
      currentNode.children.push(node);
      toTree(token.children, node);
    } else if (token.nesting === 1) {
      let node = {
        name: token.type.replace(/_open$/, ''),
        open: token,
        close: token,
        parent: currentNode,
        children: []
      };
      currentNode.children.push(node);
      currentNode = node;
    } else if (token.nesting === -1) {
      currentNode.close = token;
      currentNode = currentNode.parent;
    } else {
      let text = token.content;
      // If there is a backtick as the first or last
      // character, we need to provide spaces around
      // the code, otherwise we'll get two code blocks
      // instead of one code block with backticks in it
      if (token.type === 'code_inline') {
        if (text[0] === '`') {
          text = ' ' + text;
        }
        if (text[text.length - 1] === '`') {
          text += ' ';
        }
      }
      currentNode.children.push({
        name: token.type,
        open: token,
        close: token,
        parent: currentNode,
        children: [{
          name: 'text',
          value: text,
          parent: currentNode
        }]
      });
    }
  });
  return rootNode;
}

function getText(node: Node) {
  return node.children.reduce((textNodes, child) => {
    if (child.name === 'text') {
      textNodes.push(child);
    } else if (child.children) {
      textNodes.push(...getText(child));
    }
    return textNodes;
  }, []);
}

export class Parser {
  constructor(tokens: MarkdownIt.Token[], handlers: any) {
    this.content = '';
    this.handlers = handlers;
    this.annotations = [];
    this.walk(toTree(tokens, { children: [] }).children);
  }

  walk(nodes: Node[]) {
    nodes.forEach((node: Node) => {
      if (node.name === 'text') {
        this.content += node.value;
      } else {
        if (node.name === 'image') {
          let token = node.open;
          token.attrs = token.attrs || [];
          token.attrs.push(['alt', getText(node).map(n => n.value).join('')]);
          node.children = [];
        }
        // Identify whether the list is tight (paragraphs collapse)
        if (node.name === 'bullet_list' ||
            node.name === 'ordered_list') {
          let isTight = node.children.some(items => {
            return items.children.filter(child => child.name === 'paragraph')
                                 .some(child => child.open.hidden);
          });
          node.open.attrs = node.open.attrs || [];
          node.open.attrs.push(['tight', isTight]);
        }
        let annotationGenerator = this.convertTokenToAnnotation(node.name, node.open, node.close);
        annotationGenerator.next();
        this.walk(node.children);
        annotationGenerator.next();
      }
    });
  }

  *convertTokenToAnnotation(name: string, open: MarkdownIt.Token, close: MarkdownIt.Token) {
    let start = this.content.length;
    this.content += '\uFFFC';
    this.annotations.push({
      type: 'parse-token',
      attributes: {
        type: `${name}_open`
      },
      start,
      end: start + 1
    });
    yield;

    this.content += '\uFFFC';

    let end = this.content.length;
    let attributes = getAttributes(open);
    if (name === 'heading') {
      attributes.level = parseInt(open.tag[1], 10);
    }
    if (name === 'fence') {
      attributes.info = entities.decodeHTML5(open.info.trim());
    }

    if (this.handlers[name]) {
      Object.assign(attributes, this.handlers[name](open));
    }
    this.annotations.push({
      type: 'parse-token',
      attributes: {
        type: `${name}_close`
      },
      start: end - 1,
      end
    }, {
      type: name,
      attributes,
      start,
      end
    });
  }
}

export default class extends Document {
  constructor(markdown: string) {
    let md = MarkdownIt('commonmark');
    let parser = new Parser(md.parse(markdown, { linkify: false }), {});
    super({
      content: parser.content,
      contentType: 'text/commonmark',
      annotations: parser.annotations,
      schema
    });
  }
}
