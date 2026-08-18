'use strict';

const path = require('node:path');

const DEFAULT_ORDER = 9999;
const DEFAULT_NAV_FILE = 'generated-nav.adoc';
const DEFAULT_MAX_LEVELS = 5;

module.exports.register = function register ({ config = {} } = {}) {
  const navFile = config.nav_file || config.navFile || DEFAULT_NAV_FILE;
  const maxLevels = normalizeMaxLevels(config.max_levels || config.maxLevels || DEFAULT_MAX_LEVELS);
  const includeComponents = toMatcherConfig(config.components || config.enabled_components || config.enabledComponents);

  this.on('contentAggregated', ({ contentCatalog }) => {
    const pages = contentCatalog.getPages()
      .filter((page) => isPageIncluded(page, includeComponents))
      .filter((page) => !isNavExcluded(page));

    const groupedPages = groupByComponentVersionModule(pages);

    for (const modulePages of groupedPages.values()) {
      if (modulePages.length === 0) continue;

      const firstPage = modulePages[0];
      const tree = buildTree(modulePages, maxLevels);
      const navLines = renderNav(tree, 1, maxLevels);

      if (navLines.length === 0) continue;

      contentCatalog.addFile({
        contents: Buffer.from(`${navLines.join('\n')}\n`, 'utf8'),
        src: {
          component: firstPage.src.component,
          version: firstPage.src.version,
          module: firstPage.src.module,
          family: 'nav',
          relative: navFile,
        },
      });
    }
  });
};

function normalizeMaxLevels (value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_MAX_LEVELS;
  }

  return Math.min(parsed, DEFAULT_MAX_LEVELS);
}

function toMatcherConfig (components) {
  if (!components) return null;

  if (!Array.isArray(components)) {
    throw new Error('generated navigation extension: components must be an array');
  }

  return components.map((entry) => {
    if (typeof entry === 'string') {
      return {
        name: entry,
        versions: null,
        modules: null,
      };
    }

    if (!entry || typeof entry !== 'object' || !entry.name) {
      throw new Error('generated navigation extension: each component entry must be a string or an object with a name');
    }

    return {
      name: entry.name,
      versions: toSet(entry.versions),
      modules: toSet(entry.modules),
    };
  });
}

function toSet (value) {
  if (!value) return null;
  return new Set(Array.isArray(value) ? value : [value]);
}

function isPageIncluded (page, includeComponents) {
  if (!includeComponents) return true;

  return includeComponents.some((entry) => {
    if (entry.name !== page.src.component) return false;
    if (entry.versions && !entry.versions.has(page.src.version)) return false;
    if (entry.modules && !entry.modules.has(page.src.module)) return false;
    return true;
  });
}

function isNavExcluded (page) {
  const value = getPageAttribute(page, 'nav-exclude');

  if (value === undefined || value === null) return false;
  if (value === false) return false;

  const normalized = String(value).trim().toLowerCase();

  return normalized === '' || normalized === 'true' || normalized === 'yes' || normalized === '1';
}

function groupByComponentVersionModule (pages) {
  const result = new Map();

  for (const page of pages) {
    const key = [page.src.component, page.src.version, page.src.module].join('|');

    if (!result.has(key)) {
      result.set(key, []);
    }

    result.get(key).push(page);
  }

  return result;
}

function buildTree (pages, maxLevels) {
  const root = createDirectoryNode('', DEFAULT_ORDER);

  for (const page of pages) {
    addPageToTree(root, page, maxLevels);
  }

  updateDirectoryOrders(root);

  return root;
}

function addPageToTree (root, page, maxLevels) {
  const relativePath = normalizeResourcePath(page.src.relative || page.src.path || page.src.basename);
  const segments = relativePath.split('/').filter(Boolean);

  if (segments.length === 0) return;

  const fileName = segments[segments.length - 1];
  const directorySegments = segments.slice(0, -1);
  const maxDirectoryLevels = Math.max(maxLevels - 1, 0);
  const visibleDirectorySegments = directorySegments.slice(0, maxDirectoryLevels);
  const overflowDirectorySegments = directorySegments.slice(maxDirectoryLevels);

  let current = root;

  for (const directorySegment of visibleDirectorySegments) {
    const key = `dir:${directorySegment}`;

    if (!current.children.has(key)) {
      current.children.set(key, createDirectoryNode(toDisplayTitle(directorySegment), DEFAULT_ORDER));
    }

    current = current.children.get(key);
  }

  const baseTitle = getPageTitle(page, fileName);
  const title = overflowDirectorySegments.length > 0
    ? `${overflowDirectorySegments.map(toDisplayTitle).join(' / ')} / ${baseTitle}`
    : baseTitle;

  current.children.set(`file:${relativePath}`, {
    type: 'file',
    title,
    order: getPageOrder(page),
    xref: relativePath,
  });
}

function createDirectoryNode (title, order) {
  return {
    type: 'directory',
    title,
    order,
    children: new Map(),
  };
}

function updateDirectoryOrders (node) {
  if (node.type !== 'directory') return node.order;

  let lowestOrder = DEFAULT_ORDER;

  for (const child of node.children.values()) {
    const childOrder = child.type === 'directory'
      ? updateDirectoryOrders(child)
      : child.order;

    lowestOrder = Math.min(lowestOrder, childOrder);
  }

  node.order = lowestOrder;
  return node.order;
}

function renderNav (node, level, maxLevels) {
  const lines = [];
  const children = Array.from(node.children.values()).sort(compareEntries);

  for (const child of children) {
    const safeLevel = Math.min(level, maxLevels);
    const prefix = '*'.repeat(safeLevel);

    if (child.type === 'directory') {
      lines.push(`${prefix} ${child.title}`);
      lines.push(...renderNav(child, safeLevel + 1, maxLevels));
    } else {
      lines.push(`${prefix} xref:${child.xref}[${escapeLinkText(child.title)}]`);
    }
  }

  return lines;
}

function compareEntries (a, b) {
  if (a.order !== b.order) {
    return a.order - b.order;
  }

  if (a.type !== b.type) {
    return a.type === 'file' ? -1 : 1;
  }

  return a.title.localeCompare(b.title, 'de', { numeric: true, sensitivity: 'base' });
}

function getPageTitle (page, fileName) {
  return firstNonBlank([
    page.navtitle,
    page.title,
    getPageAttribute(page, 'page-title'),
    getPageAttribute(page, 'page-nav-title'),
    getPageAttribute(page, 'navtitle'),
    toDisplayTitle(path.basename(fileName, '.adoc')),
  ]);
}

function getPageOrder (page) {
  const value = getPageAttribute(page, 'nav-order');
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : DEFAULT_ORDER;
}

function getPageAttribute (page, name) {
  const candidates = [
    page.asciidoc && page.asciidoc.attributes,
    page.attributes,
    page.pub && page.pub.attributes,
  ];

  for (const attributes of candidates) {
    const value = readAttribute(attributes, name);

    if (value !== undefined) {
      return value;
    }
  }

  const contents = getPageContents(page);

  if (contents) {
    const escapedName = escapeRegExp(name);
    const match = contents.match(new RegExp(`^:${escapedName}:\\s*(.*?)\\s*$`, 'm'));

    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function readAttribute (attributes, name) {
  if (!attributes) return undefined;

  if (attributes instanceof Map) {
    return attributes.get(name);
  }

  if (Object.prototype.hasOwnProperty.call(attributes, name)) {
    return attributes[name];
  }

  return undefined;
}

function getPageContents (page) {
  const contents = page.contents || page.src && page.src.contents;

  if (!contents) return '';
  if (Buffer.isBuffer(contents)) return contents.toString('utf8');

  return String(contents);
}

function firstNonBlank (values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }

  return '';
}

function normalizeResourcePath (value) {
  return String(value).split(path.sep).join('/');
}

function toDisplayTitle (value) {
  return String(value)
    .replace(/\.adoc$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeLinkText (value) {
  return String(value).replace(/]/g, '\\]');
}

function escapeRegExp (value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
