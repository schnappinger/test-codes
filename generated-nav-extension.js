'use strict';

const path = require('node:path');
const Vinyl = require('vinyl');

const DEFAULT_ORDER = 9999;
const DEFAULT_NAV_FILE = 'generated-nav.adoc';
const DEFAULT_MAX_LEVELS = 5;

module.exports.register = function register ({ config = {} } = {}) {
  const navFile = config.nav_file || config.navFile || DEFAULT_NAV_FILE;
  const maxLevels = normalizeMaxLevels(config.max_levels || config.maxLevels || DEFAULT_MAX_LEVELS);
  const includeComponents = toMatcherConfig(config.components || config.enabled_components || config.enabledComponents);

  this.on('contentAggregated', ({ contentAggregate }) => {
    if (!Array.isArray(contentAggregate)) {
      throw new Error('generated navigation extension: contentAggregate is not available. Register the listener for the contentAggregated event.');
    }

    for (const componentVersion of contentAggregate) {
      if (!isComponentVersionIncluded(componentVersion, includeComponents)) continue;

      const pagesByModule = collectPagesByModule(componentVersion, includeComponents);

      for (const [moduleName, pages] of pagesByModule) {
        if (pages.length === 0) continue;

        const tree = buildTree(pages, maxLevels);
        const navLines = renderNav(tree, 1, maxLevels);

        if (navLines.length === 0) continue;

        addGeneratedNavFile(componentVersion, moduleName, navFile, navLines, pages[0].file);
      }
    }
  });
};

function collectPagesByModule (componentVersion, includeComponents) {
  const result = new Map();

  for (const file of componentVersion.files || []) {
    const srcPath = normalizeResourcePath(file.src && file.src.path);
    const match = srcPath.match(/^modules\/([^/]+)\/pages\/(.+\.adoc)$/);

    if (!match) continue;

    const moduleName = match[1];
    const relative = match[2];

    if (!isModuleIncluded(componentVersion, moduleName, includeComponents)) continue;

    const contents = getFileContents(file);

    if (isNavExcluded(contents)) continue;

    const page = {
      file,
      moduleName,
      relative,
      title: getPageTitle(contents, relative),
      order: getPageOrder(contents),
    };

    if (!result.has(moduleName)) result.set(moduleName, []);
    result.get(moduleName).push(page);
  }

  return result;
}

function addGeneratedNavFile (componentVersion, moduleName, navFile, navLines, templateFile) {
  const navPath = `modules/${moduleName}/${navFile}`;
  const origin = templateFile.src && templateFile.src.origin;
  const cwd = templateFile.cwd || templateFile._cwd || process.cwd();
  const filePath = origin && origin.worktree ? path.join(origin.worktree, navPath) : path.join(cwd, navPath);
  const contents = Buffer.from(`${navLines.join('\n')}\n`, 'utf8');

  // Important: Antora's content classifier matches nav entries against file.path,
  // and file.path must be the virtual content-source-relative path, not an absolute path.
  const generatedFile = new Vinyl({
    cwd,
    base: '.',
    path: navPath,
    contents,
  });

  generatedFile.src = {
    abspath: filePath,
    path: navPath,
    basename: navFile,
    stem: path.basename(navFile, '.adoc'),
    extname: '.adoc',
    origin,
  };

  removeExistingFile(componentVersion.files, navPath);
  componentVersion.files.push(generatedFile);
}

function removeExistingFile (files, srcPath) {
  const index = files.findIndex((file) => file.src && normalizeResourcePath(file.src.path) === srcPath);
  if (index >= 0) files.splice(index, 1);
}

function buildTree (pages, maxLevels) {
  const root = createDirectoryNode('', DEFAULT_ORDER);
  for (const page of pages) addPageToTree(root, page, maxLevels);
  updateDirectoryOrders(root);
  return root;
}

function addPageToTree (root, page, maxLevels) {
  const relativePath = normalizeResourcePath(page.relative);
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.length === 0) return;

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

  const title = overflowDirectorySegments.length > 0
    ? `${overflowDirectorySegments.map(toDisplayTitle).join(' / ')} / ${page.title}`
    : page.title;

  current.children.set(`file:${relativePath}`, {
    type: 'file',
    title,
    order: page.order,
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
    const childOrder = child.type === 'directory' ? updateDirectoryOrders(child) : child.order;
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

function getPageTitle (contents, relativePath) {
  return firstNonBlank([
    getAttribute(contents, 'page-nav-title'),
    getAttribute(contents, 'navtitle'),
    getAttribute(contents, 'page-title'),
    getDocumentTitle(contents),
    toDisplayTitle(path.basename(relativePath, '.adoc')),
  ]);
}

function getPageOrder (contents) {
  const parsed = Number(getAttribute(contents, 'nav-order'));
  return Number.isFinite(parsed) ? parsed : DEFAULT_ORDER;
}

function isNavExcluded (contents) {
  const value = getAttribute(contents, 'nav-exclude');

  if (value === undefined || value === null) return false;
  if (value === false) return false;

  const normalized = String(value).trim().toLowerCase();
  return normalized === '' || normalized === 'true' || normalized === 'yes' || normalized === '1';
}

function getAttribute (contents, name) {
  const escapedName = escapeRegExp(name);
  const match = contents.match(new RegExp(`^:${escapedName}:\\s*(.*?)\\s*$`, 'm'));
  return match ? match[1] : undefined;
}

function getDocumentTitle (contents) {
  const match = contents.match(/^=\s+(.+?)\s*$/m);
  return match ? match[1].trim() : undefined;
}

function getFileContents (file) {
  const contents = file.contents || file._contents;

  if (!contents) return '';
  if (Buffer.isBuffer(contents)) return contents.toString('utf8');

  return String(contents);
}

function compareEntries (a, b) {
  if (a.order !== b.order) return a.order - b.order;
  if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
  return a.title.localeCompare(b.title, 'de', { numeric: true, sensitivity: 'base' });
}

function normalizeMaxLevels (value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_LEVELS;
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

function isComponentVersionIncluded (componentVersion, includeComponents) {
  if (!includeComponents) return true;

  return includeComponents.some((entry) => {
    if (entry.name !== componentVersion.name) return false;
    if (entry.versions && !entry.versions.has(componentVersion.version)) return false;
    return true;
  });
}

function isModuleIncluded (componentVersion, moduleName, includeComponents) {
  if (!includeComponents) return true;

  return includeComponents.some((entry) => {
    if (entry.name !== componentVersion.name) return false;
    if (entry.versions && !entry.versions.has(componentVersion.version)) return false;
    if (entry.modules && !entry.modules.has(moduleName)) return false;
    return true;
  });
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
  return String(value || '').split(path.sep).join('/');
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
