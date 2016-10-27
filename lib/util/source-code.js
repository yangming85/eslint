/**
 * @fileoverview Abstraction of JavaScript source code.
 * @author Nicholas C. Zakas
 */
"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const TokenStore = require("../token-store"),
    Traverser = require("./traverser"),
    astUtils = require("../ast-utils");

//------------------------------------------------------------------------------
// Private
//------------------------------------------------------------------------------

/**
 * Validates that the given AST has the required information.
 * @param {ASTNode} ast The Program node of the AST to check.
 * @throws {Error} If the AST doesn't contain the correct information.
 * @returns {void}
 * @private
 */
function validate(ast) {

    if (!ast.tokens) {
        throw new Error("AST is missing the tokens array.");
    }

    if (!ast.comments) {
        throw new Error("AST is missing the comments array.");
    }

    if (!ast.loc) {
        throw new Error("AST is missing location information.");
    }

    if (!ast.range) {
        throw new Error("AST is missing range information");
    }
}

/**
 * Finds a JSDoc comment node in an array of comment nodes.
 * @param {ASTNode[]} comments The array of comment nodes to search.
 * @param {int} line Line number to look around
 * @returns {ASTNode} The node if found, null if not.
 * @private
 */
function findJSDocComment(comments, line) {

    if (comments) {
        for (let i = comments.length - 1; i >= 0; i--) {
            if (comments[i].type === "Block" && comments[i].value.charAt(0) === "*") {

                if (line - comments[i].loc.end.line <= 1) {
                    return comments[i];
                }
                break;

            }
        }
    }

    return null;
}

/**
 * Check to see if its a ES6 export declaration
 * @param {ASTNode} astNode - any node
 * @returns {boolean} whether the given node represents a export declaration
 * @private
 */
function looksLikeExport(astNode) {
    return astNode.type === "ExportDefaultDeclaration" || astNode.type === "ExportNamedDeclaration" ||
        astNode.type === "ExportAllDeclaration" || astNode.type === "ExportSpecifier";
}

/**
 * Merges two sorted lists into a larger sorted list in O(n) time
 * @param {Token[]} tokens The list of tokens
 * @param {Token[]} comments The list of comments
 * @returns {Token[]} A sorted list of tokens and comments
 */
function sortedMerge(tokens, comments) {
    const result = [];
    let tokenIndex = 0;
    let commentIndex = 0;

    while (tokenIndex < tokens.length || commentIndex < comments.length) {
        if (commentIndex >= comments.length || tokenIndex < tokens.length && tokens[tokenIndex].range[0] < comments[commentIndex].range[0]) {
            result.push(tokens[tokenIndex++]);
        } else {
            result.push(comments[commentIndex++]);
        }
    }

    return result;
}

//------------------------------------------------------------------------------
// Public Interface
//------------------------------------------------------------------------------

/**
 * Represents parsed source code.
 * @param {string} text - The source code text.
 * @param {ASTNode} ast - The Program node of the AST representing the code. This AST should be created from the text that BOM was stripped.
 * @constructor
 */
function SourceCode(text, ast) {
    validate(ast);

    /**
     * The flag to indicate that the source code has Unicode BOM.
     * @type boolean
     */
    this.hasBOM = (text.charCodeAt(0) === 0xFEFF);

    /**
     * The original text source code.
     * BOM was stripped from this text.
     * @type string
     */
    this.text = (this.hasBOM ? text.slice(1) : text);

    /**
     * The parsed AST for the source code.
     * @type ASTNode
     */
    this.ast = ast;

    /**
     * The source code split into lines according to ECMA-262 specification.
     * This is done to avoid each rule needing to do so separately.
     * @type string[]
     */
    this.lines = SourceCode.splitLines(this.text);

    // Check the source text for the presence of a shebang since it is parsed as a standard line comment.
    const shebangTest = this.text.match(/^#!([^\r\n]+)/);
    const hasShebang = shebangTest && ast.comments.length && ast.comments[0].value === shebangTest[1];

    if (hasShebang) {
        ast.comments[0].type = "Shebang";
    }

    this.tokensAndComments = sortedMerge(ast.tokens, ast.comments);

    // create token store methods
    const tokenStore = new TokenStore(ast.tokens, ast.comments);

    for (const methodName of TokenStore.PUBLIC_METHODS) {
        this[methodName] = tokenStore[methodName].bind(tokenStore);
    }

    this._commentStore = new WeakMap();

    // don't allow modification of this object
    Object.freeze(this);
    Object.freeze(this.lines);
}

/**
 * Split the source code into multiple lines based on the line delimiters
 * @param {string} text Source code as a string
 * @returns {string[]} Array of source code lines
 * @public
 */
SourceCode.splitLines = function(text) {
    return text.split(astUtils.createGlobalLinebreakMatcher());
};

SourceCode.prototype = {
    constructor: SourceCode,

    /**
     * Gets the source code for the given node.
     * @param {ASTNode=} node The AST node to get the text for.
     * @param {int=} beforeCount The number of characters before the node to retrieve.
     * @param {int=} afterCount The number of characters after the node to retrieve.
     * @returns {string} The text representing the AST node.
     */
    getText(node, beforeCount, afterCount) {
        if (node) {
            return this.text.slice(Math.max(node.range[0] - (beforeCount || 0), 0),
                node.range[1] + (afterCount || 0));
        }
        return this.text;


    },

    /**
     * Gets the entire source text split into an array of lines.
     * @returns {Array} The source text as an array of lines.
     */
    getLines() {
        return this.lines;
    },

    /**
     * Retrieves an array containing all comments in the source code.
     * @returns {ASTNode[]} An array of comment nodes.
     */
    getAllComments() {
        return this.ast.comments;
    },

    /**
     * Gets all comments for the given node.
     * @param {ASTNode} node The AST node to get the comments for.
     * @returns {Object} The list of comments indexed by their position.
     * @public
     */
    getComments(node) {
        if (this._commentStore.has(node)) {
            return this._commentStore.get(node);
        }

        const comments = {
            leading: [],
            trailing: []
        };

        /*
         * Return all comments as leading comments of the Program node when there is no
         * executable code. Return comments as trailing comments of nodes that only contain
         * comments (to mimic the comment attachment behavior present in Espree).
         */
        if (node.type === "Program") {
            if (node.body.length === 0) {
                comments.leading = node.comments;
            }
        } else if ((node.type === "BlockStatement" || node.type === "ClassBody") && node.body.length === 0 ||
            node.type === "ObjectExpression" && node.properties.length === 0 ||
            node.type === "ArrayExpression" && node.elements.length === 0 ||
            node.type === "SwitchStatement" && node.cases.length === 0
        ) {
            comments.trailing = this.getTokens(node, {
                includeComments: true,
                filter: astUtils.isCommentToken
            });
        } else {

            /*
             * Iterate over tokens before and after node and collect comment tokens.
             * Do not include comments that exist outside of the parent node
             * to avoid duplication.
             */
            let currentToken = this.getTokenBefore(node, { includeComments: true });

            while (currentToken && astUtils.isCommentToken(currentToken)) {
                if (node.parent && (currentToken.start < node.parent.start)) {
                    break;
                }
                comments.leading.unshift(currentToken);
                currentToken = this.getTokenBefore(currentToken, { includeComments: true });
            }

            currentToken = this.getTokenAfter(node, { includeComments: true });

            while (currentToken && astUtils.isCommentToken(currentToken)) {
                if (node.parent && (currentToken.end > node.parent.end)) {
                    break;
                }
                comments.trailing.push(currentToken);
                currentToken = this.getTokenAfter(currentToken, { includeComments: true });
            }
        }

        this._commentStore.set(node, comments);
        return comments;
    },

    /**
     * Retrieves the JSDoc comment for a given node.
     * @param {ASTNode} node The AST node to get the comment for.
     * @returns {ASTNode} The Block comment node containing the JSDoc for the
     *      given node or null if not found.
     * @public
     */
    getJSDocComment(node) {
        let parent = node.parent;
        const leadingComments = this.getComments(node).leading;

        switch (node.type) {
            case "ClassDeclaration":
            case "FunctionDeclaration":
                if (looksLikeExport(parent)) {
                    return findJSDocComment(this.getComments(parent).leading, parent.loc.start.line);
                }
                return findJSDocComment(leadingComments, node.loc.start.line);

            case "ClassExpression":
                return findJSDocComment(this.getComments(parent.parent).leading, parent.parent.loc.start.line);

            case "ArrowFunctionExpression":
            case "FunctionExpression":
                if (parent.type !== "CallExpression" && parent.type !== "NewExpression") {
                    let parentLeadingComments = this.getComments(parent).leading;

                    while (!parentLeadingComments.length && !/Function/.test(parent.type) && parent.type !== "MethodDefinition" && parent.type !== "Property") {
                        parent = parent.parent;

                        if (!parent) {
                            break;
                        }

                        parentLeadingComments = this.getComments(parent).leading;
                    }

                    return parent && (parent.type !== "FunctionDeclaration") ? findJSDocComment(parentLeadingComments, parent.loc.start.line) : null;
                } else if (leadingComments.length) {
                    return findJSDocComment(leadingComments, node.loc.start.line);
                }

            // falls through

            default:
                return null;
        }
    },

    /**
     * Gets the deepest node containing a range index.
     * @param {int} index Range index of the desired node.
     * @returns {ASTNode} The node if found or null if not found.
     */
    getNodeByRangeIndex(index) {
        let result = null,
            resultParent = null;
        const traverser = new Traverser();

        traverser.traverse(this.ast, {
            enter(node, parent) {
                if (node.range[0] <= index && index < node.range[1]) {
                    result = node;
                    resultParent = parent;
                } else {
                    this.skip();
                }
            },
            leave(node) {
                if (node === result) {
                    this.break();
                }
            }
        });

        return result ? Object.assign({ parent: resultParent }, result) : null;
    },

    /**
     * Determines if two tokens have at least one whitespace character
     * between them. This completely disregards comments in making the
     * determination, so comments count as zero-length substrings.
     * @param {Token} first The token to check after.
     * @param {Token} second The token to check before.
     * @returns {boolean} True if there is only space between tokens, false
     *  if there is anything other than whitespace between tokens.
     */
    isSpaceBetweenTokens(first, second) {
        const text = this.text.slice(first.range[1], second.range[0]);

        return /\s/.test(text.replace(/\/\*.*?\*\//g, ""));
    }
};


module.exports = SourceCode;
