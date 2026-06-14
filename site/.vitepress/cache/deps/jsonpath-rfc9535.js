import {
  parser_default
} from "./chunk-76KBYWPW.js";
import {
  __publicField
} from "./chunk-V6TY7KAL.js";

// node_modules/jsonpath-rfc9535/dist/esm/utils/stack.js
var Stack = class {
  constructor() {
    __publicField(this, "head", null);
    __publicField(this, "tail", null);
    __publicField(this, "size", 0);
  }
  push(element) {
    const newNode = { value: element, next: null };
    if (this.tail !== null) {
      this.tail.next = newNode;
    }
    this.tail = newNode;
    if (this.head === null) {
      this.head = newNode;
    }
    this.size++;
  }
  pop() {
    if (this.head === null)
      return;
    const value2 = this.head.value;
    this.head = this.head.next;
    if (this.head === null) {
      this.tail = null;
    }
    this.size--;
    return value2;
  }
};

// node_modules/jsonpath-rfc9535/dist/esm/utils/guards.js
function isPlainObject(value2) {
  if (typeof value2 !== "object" || value2 === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value2);
  return prototype === null || prototype === Object.prototype;
}
var isStackItemWithArrayValue = (item) => Array.isArray(item.value);
var isStackItemWithObjectValue = (item) => isPlainObject(item.value);

// node_modules/jsonpath-rfc9535/dist/esm/core/results.js
var nodeLists = /* @__PURE__ */ new WeakSet();
var isNodeList = (value2) => {
  return typeof value2 === "object" && value2 !== null && nodeLists.has(value2);
};
var isJsonValue = (value2) => {
  switch (typeof value2) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      return value2 === null || isPlainObject(value2) || isArray(value2);
    default:
      return false;
  }
};
var isArray = (value2) => Array.isArray(value2) && !isNodeList(value2);
var createNodeList = () => {
  const list = [];
  nodeLists.add(list);
  return list;
};
var Nothing = Symbol("Nothing");

// node_modules/jsonpath-rfc9535/dist/esm/core/functions/count.js
var count_default = {
  declaration: function count(ctx, value2) {
    if (isNodeList(value2)) {
      return value2.length;
    }
    return 0;
  },
  definition: {
    parameters: ["NodesType"],
    returnType: "ValueType"
  }
};

// node_modules/jsonpath-rfc9535/dist/esm/core/functions/length.js
function countUnicodeScalarValues(str) {
  let count2 = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0 && code <= 55295 || code >= 57344 && code <= 1114111) {
      count2++;
    }
  }
  return count2;
}
var length_default = {
  declaration: function length(ctx, value2) {
    if (typeof value2 === "string") {
      return countUnicodeScalarValues(value2);
    }
    if (Array.isArray(value2)) {
      return value2.length;
    }
    if (isPlainObject(value2)) {
      return Object.keys(value2).length;
    }
    return Nothing;
  },
  definition: {
    parameters: ["ValueType"],
    returnType: "ValueType"
  }
};

// node_modules/jsonpath-rfc9535/dist/esm/core/functions/utils/construct-regex.js
function isBackslash(code) {
  return code === 92;
}
function eatCharacterClass(pattern, start) {
  let maybeEscaped = false;
  let i = start;
  while (i < pattern.length) {
    const ch = pattern.charCodeAt(i);
    i++;
    if (isBackslash(ch)) {
      maybeEscaped = true;
      continue;
    }
    if (ch === 93) {
      if (!maybeEscaped) {
        break;
      }
      maybeEscaped = false;
    }
  }
  return i;
}
function toEcmaScriptPattern(pattern) {
  let ecmaScriptPattern = pattern;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charCodeAt(i);
    if (isBackslash(ch)) {
      i++;
    } else if (ch === 91) {
      i = eatCharacterClass(pattern, i);
    } else if (ch === 46) {
      ecmaScriptPattern = `${pattern.slice(0, i)}[^
\r]${pattern.slice(i + 1)}`;
    }
  }
  return ecmaScriptPattern;
}
function constructRegex({ cache }, pattern) {
  const store = cache.get("regexps") ?? {};
  if (!cache.has("regexps")) {
    cache.set("regexps", store);
  }
  if (Object.hasOwn(store, pattern)) {
    return store[pattern];
  }
  try {
    const r = RegExp(toEcmaScriptPattern(pattern), "u");
    store[pattern] = r;
    return r;
  } catch {
    store[pattern] = null;
    return null;
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/functions/match.js
var match_default = {
  declaration: function match(ctx, value2, pattern) {
    var _a;
    if (typeof value2 !== "string" || typeof pattern !== "string") {
      return false;
    }
    return ((_a = constructRegex(ctx, `^${pattern}$`)) == null ? void 0 : _a.test(value2)) === true;
  },
  definition: {
    parameters: ["ValueType", "ValueType"],
    returnType: "LogicalType"
  }
};

// node_modules/jsonpath-rfc9535/dist/esm/core/functions/search.js
var search_default = {
  declaration: function search(ctx, value2, pattern) {
    var _a;
    if (typeof value2 !== "string" || typeof pattern !== "string") {
      return false;
    }
    return ((_a = constructRegex(ctx, pattern)) == null ? void 0 : _a.test(value2)) === true;
  },
  definition: {
    parameters: ["ValueType", "ValueType"],
    returnType: "LogicalType"
  }
};

// node_modules/jsonpath-rfc9535/dist/esm/core/functions/value.js
var value_default = {
  declaration: function value(ctx, nodes) {
    if (nodes.length === 1) {
      return nodes[0];
    }
    return Nothing;
  },
  definition: {
    parameters: ["NodesType"],
    returnType: "ValueType"
  }
};

// node_modules/jsonpath-rfc9535/dist/esm/core/path.js
var EMPTY_PATH = [];
function joinPathWithKey(path, key) {
  if (path === EMPTY_PATH) {
    return EMPTY_PATH;
  }
  if (typeof key === "number") {
    return [...path, key];
  }
  return [...path, toNormalizedKey(key)];
}
function getInitialPath(capturePaths) {
  return capturePaths ? [] : EMPTY_PATH;
}
var ESCAPE_REGEX = (
  // biome-ignore lint/suspicious/noControlCharactersInRegex: we need control characters to escape Unicode characters
  /[\u0000-\u001f'\\]/g
);
function escapeValue(ch) {
  const code = ch.charCodeAt(0);
  switch (code) {
    case 8:
      return "\\b";
    case 12:
      return "\\f";
    case 10:
      return "\\n";
    case 13:
      return "\\r";
    case 9:
      return "\\t";
    case 39:
      return "\\'";
    case 92:
      return "\\\\";
    default:
      return `\\u${code.toString(16).padStart(4, "0")}`;
  }
}
function toNormalizedKey(key) {
  return key.replace(ESCAPE_REGEX, escapeValue);
}
function toNormalizedPath(path) {
  let normalizedPath = "$";
  for (const key of path) {
    if (typeof key === "number") {
      normalizedPath += `[${key}]`;
    } else {
      normalizedPath += `['${key}']`;
    }
  }
  return normalizedPath;
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/assertions.js
function assertDefinedNodeType(node) {
  throw new TypeError(
    // biome-ignore lint/complexity/useLiteralKeys: type exhaustiveness
    `Unexpected node type: ${node["type"]}`
  );
}
function assertDefinedComparisonOp(op) {
  throw new TypeError(`Unexpected comparison operator: ${op}`);
}
function assertNever(_, message) {
  throw new Error(message);
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/get-type.js
function getType(value2) {
  switch (typeof value2) {
    case "object":
      if (value2 === null) {
        return "null";
      }
      if (isNodeList(value2)) {
        return "NodeList";
      }
      if (isArray(value2)) {
        return "array";
      }
      if (isPlainObject(value2)) {
        return "object";
      }
      throw new TypeError(`Unknown type: ${value2}`);
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      if (value2 === Nothing) {
        return "Nothing";
      }
      throw new TypeError(`Unknown type: ${value2}`);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/is-equal.js
function isEqualArray(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (!isEqual(a[i], b[i])) {
      return false;
    }
  }
  return true;
}
function isEqualObject(a, b) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) {
      return false;
    }
    if (!isEqual(a[key], b[key])) {
      return false;
    }
  }
  return true;
}
function isEqual(left, right) {
  if (getType(left) !== getType(right)) {
    return false;
  }
  switch (getType(left)) {
    case "string":
    case "number":
    case "boolean":
    case "null":
      return left === right;
    case "object":
      return isEqualObject(left, right);
    case "array":
    case "NodeList":
      return isEqualArray(left, right);
    default:
      return false;
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/comparers/array.js
function compareArrays(a, b, op) {
  switch (op) {
    case "==":
    case ">=":
    case "<=":
      return !isNodeList(a) && !isNodeList(b) && isEqual(a, b);
    case "<":
    case ">":
      return false;
    case "!=":
      return !compareArrays(a, b, "==");
    default:
      assertDefinedComparisonOp(op);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/comparers/node-lists.js
function compareNodeLists(a, b, op) {
  switch (op) {
    case "==":
    case "<=":
    case ">=":
      return isNodeList(a) && (isNodeList(b) && isEqual(a, b) || b === Nothing);
    case "<":
    case ">":
      return false;
    case "!=":
      return !compareNodeLists(a, b, "==");
    default:
      assertDefinedComparisonOp(op);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/comparers/nothing.js
function compareNothing(a, b, op) {
  switch (op) {
    case "==":
    case "<=":
    case ">=":
      return b === Nothing || isNodeList(b) && b.length === 0;
    case "<":
    case ">":
      return false;
    case "!=":
      return !compareNothing(a, b, "==");
    default:
      assertDefinedComparisonOp(op);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/comparers/number.js
function compareNumbers(a, b, op) {
  switch (op) {
    case "==":
      return a === b;
    case "<":
      return typeof b === "number" && a < b;
    case "!=":
      return !compareNumbers(a, b, "==");
    case "<=":
      return compareNumbers(a, b, "<") || compareNumbers(a, b, "==");
    case ">":
      return typeof b === "number" && compareNumbers(b, a, "<");
    case ">=":
      return typeof b === "number" && compareNumbers(b, a, "<") || compareNumbers(a, b, "==");
    default:
      assertDefinedComparisonOp(op);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/comparers/object.js
function compareObjects(a, b, op) {
  switch (op) {
    case "==":
    case "<=":
    case ">=":
      return isEqual(a, b);
    case "<":
    case ">":
      return false;
    case "!=":
      return !isEqual(a, b);
    default:
      assertDefinedComparisonOp(op);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/comparers/primitives.js
function comparePrimitives(a, b, op) {
  switch (op) {
    case "==":
    case "<=":
    case ">=":
      return a === b;
    case "<":
    case ">":
      return false;
    case "!=":
      return !comparePrimitives(a, b, "==");
    default:
      assertDefinedComparisonOp(op);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/comparers/string.js
function compareString(a, b, op) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  switch (op) {
    case "==":
      return a === b;
    case "<": {
      let index = 0;
      while (a.length > index && b.length > index) {
        const leftCode = a.charCodeAt(index);
        const rightCode = b.charCodeAt(index);
        if (leftCode === rightCode) {
          index++;
          continue;
        }
        return a.charCodeAt(index) < b.charCodeAt(index);
      }
      return a.length < b.length;
    }
    default:
      assertDefinedComparisonOp(op);
  }
}
function string_default(a, b, op) {
  switch (op) {
    case "==":
    case "<":
      return compareString(a, b, op);
    case "!=":
      return !compareString(a, b, "==");
    case "<=":
      return compareString(a, b, "<") || compareString(a, b, "==");
    case ">":
      return compareString(b, a, "<");
    case ">=":
      return compareString(b, a, "<") || compareString(a, b, "==");
    default:
      assertDefinedComparisonOp(op);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/utils/comparers/compare.js
function compare(a, b, op) {
  const leftValue = isNodeList(a) && a.length === 1 ? a[0] : a;
  const leftType = getType(leftValue);
  const rightValue = isNodeList(b) && b.length === 1 ? b[0] : b;
  switch (leftType) {
    case "string":
      return string_default(leftValue, rightValue, op);
    case "number":
      return compareNumbers(leftValue, rightValue, op);
    case "boolean":
    case "null":
      return comparePrimitives(leftValue, rightValue, op);
    case "object":
      return compareObjects(leftValue, rightValue, op);
    case "array":
      return compareArrays(leftValue, rightValue, op);
    case "Nothing":
      return compareNothing(leftValue, rightValue, op);
    case "NodeList":
      return compareNodeLists(leftValue, rightValue, op);
    default:
      assertNever(leftType, "Unknown type");
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/evaluators/filter-query.js
function evalFilterQuery(ctx, item, node) {
  const list = createNodeList();
  switch (node.value.type) {
    case "RelQuery":
      visitQuery(ctx, item.root, item.value, node.value, (value2) => {
        list.push(value2);
      });
      break;
    case "JsonPathQuery":
      visitQuery(ctx, item.root, item.root, node.value, (value2) => {
        list.push(value2);
      });
      break;
    default:
      assertDefinedNodeType(node.value);
  }
  return list;
}

// node_modules/jsonpath-rfc9535/dist/esm/core/evaluators/test-expr.js
function evalTestExpr(ctx, item, node) {
  switch (node.expression.type) {
    case "FilterQuery":
      return evalFilterQuery(ctx, item, node.expression).length > 0;
    case "FunctionExpr":
      return evalFunctionExpr(ctx, item, node.expression) === true;
    default:
      assertDefinedNodeType(node.expression);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/evaluators/logical-expr.js
function evalLogicalExpr(ctx, item, node) {
  switch (node.type) {
    case "LogicalNotExpr":
      return !evalLogicalExpr(ctx, item, node.expression);
    case "LogicalAndExpr":
      return evalLogicalExpr(ctx, item, node.left) && evalLogicalExpr(ctx, item, node.right);
    case "LogicalOrExpr":
      return evalLogicalExpr(ctx, item, node.left) || evalLogicalExpr(ctx, item, node.right);
    case "TestExpr":
      return evalTestExpr(ctx, item, node);
    case "ComparisonExpr":
      return evalComparisonExpr(ctx, item, node);
    default:
      assertDefinedNodeType(node);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/evaluators/function-argument.js
function evalFunctionArgument(ctx, item, node) {
  switch (node.type) {
    case "FunctionExpr":
      return evalFunctionExpr(ctx, item, node);
    case "FilterQuery":
      return evalFilterQuery(ctx, item, node);
    case "LogicalNotExpr":
    case "LogicalAndExpr":
    case "LogicalOrExpr":
    case "TestExpr":
      return evalLogicalExpr(ctx, item, node);
    case "Literal":
      return node.value;
    default:
      assertDefinedNodeType(node);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/evaluators/function-expr.js
function coerceValueType(value2) {
  if (isNodeList(value2)) {
    return value2.length === 1 ? value2[0] : Nothing;
  }
  return value2;
}
function evalFunctionExpr(ctx, item, node) {
  if (!isKnownFunction(ctx.functions, node.name)) {
    return false;
  }
  const fn = ctx.functions[node.name];
  if (fn.definition.parameters.length !== node.arguments.length) {
    return false;
  }
  const args = [];
  for (let i = 0; i < node.arguments.length; i++) {
    const value2 = evalFunctionArgument(ctx, item, node.arguments[i]);
    const param = fn.definition.parameters[i];
    switch (param) {
      case "ValueType":
        if (!isNodeList(value2) && !isJsonValue(value2)) {
          return false;
        }
        args.push(coerceValueType(value2));
        break;
      case "NodesType":
        if (!isNodeList(value2)) {
          return false;
        }
        args.push(value2);
        break;
      case "LogicalType":
        if (typeof value2 === "boolean") {
          args.push(value2);
        } else if (isNodeList(value2)) {
          args.push(value2.length > 0);
        } else {
          return false;
        }
        break;
      default:
        assertNever(param, "Unknown function argument type");
    }
  }
  return fn.declaration(
    ctx,
    ...args
  );
}
function isKnownFunction(functions, name) {
  return Object.hasOwn(functions, name);
}

// node_modules/jsonpath-rfc9535/dist/esm/core/evaluators/comparable.js
function evalComparable(ctx, item, node) {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "RelSingularQuery":
    case "AbsSingularQuery": {
      const root = node.type === "RelSingularQuery" ? item.value : item.root;
      if (node.segments.length === 0) {
        return root;
      }
      const nodeList = createNodeList();
      visitQuery(ctx, item.root, root, node, (v) => {
        nodeList.push(v);
      });
      return nodeList;
    }
    case "FunctionExpr":
      return evalFunctionExpr(ctx, item, node);
    default:
      assertDefinedNodeType(node);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/evaluators/comparison-expr.js
function evalComparisonExpr(ctx, item, node) {
  const leftValue = evalComparable(ctx, item, node.left);
  const rightValue = evalComparable(ctx, item, node.right);
  return compare(leftValue, rightValue, node.op);
}

// node_modules/jsonpath-rfc9535/dist/esm/core/visitors/filter-selector.js
function visitFilterSelector(ctx, item, node) {
  if (node.value.type === "ComparisonExpr") {
    if (!evalComparisonExpr(ctx, item, node.value)) {
      return;
    }
  } else if (!evalLogicalExpr(ctx, item, node.value)) {
    return;
  }
  ctx.stack.push({
    root: item.root,
    path: item.path,
    value: item.value,
    index: item.index + 1
  });
}

// node_modules/jsonpath-rfc9535/dist/esm/core/visitors/index-selector.js
function getArrayIndex(index, length2) {
  return index < 0 ? length2 + index : index;
}
function visitIndexSelector(ctx, item, node) {
  const index = getArrayIndex(node.value, item.value.length);
  if (index >= 0 && index < item.value.length) {
    ctx.stack.push({
      root: item.root,
      path: joinPathWithKey(item.path, index),
      value: item.value[index],
      index: item.index + 1
    });
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/visitors/name-selector.js
function visitNameSelector(ctx, { root, path, value: value2, index }, node) {
  if (Object.hasOwn(value2, node.value)) {
    ctx.stack.push({
      root,
      path: joinPathWithKey(path, node.value),
      value: value2[node.value],
      index: index + 1
    });
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/visitors/slice-selector.js
function normalize(i, len) {
  return i >= 0 ? i : len + i;
}
function bounds(start, end, step, len) {
  const nStart = normalize(start, len);
  const nEnd = normalize(end, len);
  if (step >= 0) {
    const lower2 = Math.min(Math.max(nStart, 0), len);
    const upper2 = Math.min(Math.max(nEnd, 0), len);
    return [lower2, upper2];
  }
  const upper = Math.min(Math.max(nStart, -1), len - 1);
  const lower = Math.min(Math.max(nEnd, -1), len - 1);
  return [lower, upper];
}
function visitSliceSelector(ctx, { root, path, value: value2, index }, node) {
  const step = node.step ?? 1;
  const defaultStart = step >= 0 ? 0 : value2.length - 1;
  const defaultEnd = step >= 0 ? value2.length : -value2.length - 1;
  const nStart = node.start === null ? defaultStart : normalize(node.start, value2.length);
  const nEnd = node.end === null ? defaultEnd : normalize(node.end, value2.length);
  const [lower, upper] = bounds(nStart, nEnd, step, value2.length);
  if (step > 0) {
    let i = lower;
    while (i < upper) {
      ctx.stack.push({
        root,
        path: joinPathWithKey(path, i),
        value: value2[i],
        index: index + 1
      });
      i += step;
    }
  } else if (step < 0) {
    let i = upper;
    while (lower < i) {
      ctx.stack.push({
        root,
        path: joinPathWithKey(path, i),
        value: value2[i],
        index: index + 1
      });
      i += step;
    }
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/visitors/wildcard-selector.js
function visitWildcardSelector(ctx, { root, path, value: value2, index }) {
  if (Array.isArray(value2)) {
    for (let i = 0; i < value2.length; i++) {
      ctx.stack.push({
        root,
        path: joinPathWithKey(path, i),
        value: value2[i],
        index: index + 1
      });
    }
  } else if (isPlainObject(value2)) {
    for (const key of Object.keys(value2)) {
      ctx.stack.push({
        root,
        path: joinPathWithKey(path, key),
        value: value2[key],
        index: index + 1
      });
    }
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/visitors/bracketed-selection.js
function visitBracketedSelection(ctx, item, node) {
  for (const selector of node.selectors) {
    switch (selector.type) {
      case "NameSelector":
        if (isStackItemWithObjectValue(item)) {
          visitNameSelector(ctx, item, selector);
        }
        break;
      case "SliceSelector":
        if (isStackItemWithArrayValue(item)) {
          visitSliceSelector(ctx, item, selector);
        }
        break;
      case "IndexSelector": {
        if (isStackItemWithArrayValue(item)) {
          visitIndexSelector(ctx, item, selector);
        }
        break;
      }
      case "WildcardSelector":
        visitWildcardSelector(ctx, item);
        break;
      case "FilterSelector": {
        if (isStackItemWithArrayValue(item)) {
          visitFilterSelectorForArrayItem(ctx, item, selector);
        } else if (isStackItemWithObjectValue(item)) {
          visitFilterSelectorForObjectItem(ctx, item, selector);
        }
        break;
      }
      default:
        assertDefinedNodeType(selector);
    }
  }
}
function visitFilterSelectorForArrayItem(ctx, { root, path, value: value2, index }, node) {
  for (let i = 0; i < value2.length; i++) {
    visitFilterSelector(ctx, {
      root,
      path: joinPathWithKey(path, i),
      value: value2[i],
      index
    }, node);
  }
}
function visitFilterSelectorForObjectItem(ctx, { root, path, value: value2, index }, node) {
  for (const key of Object.keys(value2)) {
    visitFilterSelector(ctx, {
      root,
      path: joinPathWithKey(path, key),
      value: value2[key],
      index
    }, node);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/visitors/member-name-shorthand.js
function visitMemberNameShorthand(ctx, { root, path, value: value2, index }, node) {
  if (Object.hasOwn(value2, node.value)) {
    ctx.stack.push({
      root,
      path: joinPathWithKey(path, node.value),
      value: value2[node.value],
      index: index + 1
    });
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/visitors/segment.js
function visitSegment(ctx, item, node) {
  switch (node.type) {
    case "BracketedSelection":
      return visitBracketedSelection(ctx, item, node);
    case "WildcardSelector":
      return visitWildcardSelector(ctx, item);
    case "MemberNameShorthand":
      if (isStackItemWithObjectValue(item)) {
        visitMemberNameShorthand(ctx, item, node);
      }
      break;
    case "NameSelector":
      if (isStackItemWithObjectValue(item)) {
        visitNameSelector(ctx, item, node);
      }
      break;
    case "IndexSelector":
      if (isStackItemWithArrayValue(item)) {
        visitIndexSelector(ctx, item, node);
      }
      break;
    default:
      assertDefinedNodeType(node);
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/visitors/query.js
function visitQuery(ctx, root, input, node, cb) {
  const stack = new Stack();
  stack.push({
    root,
    path: getInitialPath(ctx.capturePaths),
    value: input,
    index: 0
  });
  const context = {
    cache: ctx.cache,
    capturePaths: false,
    functions: ctx.functions,
    regexp: ctx.regexp,
    stack
  };
  while (stack.size > 0) {
    const item = stack.pop();
    if (item.index === node.segments.length) {
      cb(item.value, item.path);
      continue;
    }
    const { path, value: value2, index } = item;
    const segment = node.segments[index];
    visitSegment(context, item, segment.node);
    if (segment.type === "DescendantSegment") {
      if (Array.isArray(value2)) {
        for (let i = 0; i < value2.length; i++) {
          stack.push({
            root,
            path: joinPathWithKey(path, i),
            value: value2[i],
            index
          });
        }
      } else if (value2 !== null && typeof value2 === "object") {
        for (const key of Object.keys(value2)) {
          stack.push({
            root,
            path: joinPathWithKey(path, key),
            value: value2[key],
            index
          });
        }
      }
    }
  }
}

// node_modules/jsonpath-rfc9535/dist/esm/core/exec.js
function exec(input, expression, opts, cb) {
  const ctx = {
    cache: /* @__PURE__ */ new Map(),
    capturePaths: opts.capturePaths,
    functions: {
      count: count_default,
      search: search_default,
      value: value_default,
      match: match_default,
      length: length_default
    },
    regexp: "i-regexp",
    stack: new Stack()
  };
  visitQuery(ctx, input, input, parser_default(expression), cb);
}

// node_modules/jsonpath-rfc9535/dist/esm/index.js
var DEFAULT_OPTIONS = {
  capturePaths: true
};
function query(input, expression) {
  const values = [];
  exec(input, expression, { capturePaths: false }, (value2) => {
    values.push(value2);
  });
  return values;
}
function paths(input, expression) {
  const paths2 = [];
  exec(input, expression, DEFAULT_OPTIONS, (_, path) => {
    paths2.push(toNormalizedPath(path));
  });
  return paths2;
}
function exec2(input, expression, cb) {
  exec(input, expression, DEFAULT_OPTIONS, cb);
}
function batchExec(input, expressionToCallback, errorCallback) {
  for (const [expression, cb] of expressionToCallback) {
    try {
      exec2(input, expression, cb);
    } catch (e) {
      errorCallback == null ? void 0 : errorCallback(e instanceof Error ? e : new Error(String(e)), expression);
    }
  }
}
export {
  batchExec,
  exec2 as exec,
  paths,
  query
};
//# sourceMappingURL=jsonpath-rfc9535.js.map
