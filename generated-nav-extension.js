'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_ORDER = 9999;
const DEFAULT_NAV_FILE = 'generated-nav.adoc';
const DEFAULT_MAX_LEVELS = 5;

module.exports.register = function register ({ config = {} } = {}) {
  const navFile = config.nav_file || config.navFile || DEFAULT_NAV_FILE;
  const maxLevels = normalizeMaxLevels(config.max_levels || config.maxLevels || DEFAULT_MAX_LEVELS);
  const includeComponents = toMatcherConfig(config.components || config.enabled_components || config.enabledComponents);

  this.on('contentAggregated', ({ contentAggregate }) => {
    if (!Array.isArray(contentAggregate)) {
      throw new Error('generated navigation extension: contentAggregate is not available at contentAggregated');
    }

    for (const componentVersion of contentAggregate) {
      if (!isComponentVersionIncluded(componentVersion, includeComponents)) continue;

      const pagesByModule = collectPagesByModule(componentVersion, includeComponents);

      for (const [moduleName, pages] of pagesByModule) {
        if (pages.length === 0) continue;

        const tree = buildTree(pages, maxLevels);
        const navLines = renderNav(tree, 1, maxLevels);

        if (navLines.length > 0) {
          addGeneratedNavFile(componentVersion, moduleName, navFile, navLines, pages[0].file);
        }
      }
    }
  });

  this.on('contentClassified', ({ contentCatalog }) => {
    if (!contentCatalog) {
      throw new Error('generated navigation extension: contentCatalog is not available at contentClassified');
    }

    addGitMetadata(contentCatalog, includeComponents);
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
  const base = templateFile.base || templateFile._base || cwd;
  const absolutePath = origin && origin.worktree ? path.join(origin.worktree, navPath) : path.join(cwd, navPath);

  const generatedFile = {
    cwd,
    base,
    path: navPath,
    contents: Buffer.from(`${navLines.join('\n')}\n`, 'utf8'),
    src: {
      abspath: absolutePath,
      path: navPath,
      basename: navFile,
      stem: path.basename(navFile, '.adoc'),
      extname: '.adoc',
      origin,
    },
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

  const fileStem = path.basename(segments[segments.length - 1], '.adoc');
  const directorySegments = segments.slice(0, -1);
  const isFolderIndexPage = directorySegments.length > 0 && fileStem === directorySegments[directorySegments.length - 1];
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

  if (isFolderIndexPage && overflowDirectorySegments.length === 0) {
    current.page = { type: 'file', title: page.title, order: page.order, xref: relativePath };
    current.title = page.title;
    current.order = Math.min(current.order, page.order);
    return;
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
  return { type: 'directory', title, order, page: null, children: new Map() };
}

function updateDirectoryOrders (node) {
  if (node.type !== 'directory') return node.order;

  let lowestOrder = node.page ? node.page.order : DEFAULT_ORDER;
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
      if (child.page) {
        lines.push(`${prefix} xref:${child.page.xref}[${escapeLinkText(child.page.title)}]`);
      } else {
        lines.push(`${prefix} ${child.title}`);
      }
      lines.push(...renderNav(child, safeLevel + 1, maxLevels));
    } else {
      lines.push(`${prefix} xref:${child.xref}[${escapeLinkText(child.title)}]`);
    }
  }

  return lines;
}

function addGitMetadata (contentCatalog, includeComponents) {
  const historyCache = new Map();

  for (const page of contentCatalog.getPages()) {
    if (!isCatalogPageIncluded(page, includeComponents)) continue;

    const origin = page.src && page.src.origin;
    const repository = resolveRepository(origin);
    if (!repository) continue;

    const reference = resolveGitReference(origin);
    const cacheKey = `${repository.mode}|${repository.location}|${reference}`;

    if (!historyCache.has(cacheKey)) {
      historyCache.set(cacheKey, loadRepositoryHistory(repository, reference));
    }

    const repositoryPath = resolveRepositoryPath(page.src.path, origin && origin.startPath);
    const metadata = historyCache.get(cacheKey).get(repositoryPath);
    if (!metadata) continue;

    page.src.lastModified = metadata.timestamp;
    page.src.lastModifiedEpoch = metadata.epoch;
    page.src.lastCommit = metadata.commit;

    page.attributes = Object.assign({}, page.attributes, {
      lastModified: metadata.timestamp,
      lastModifiedEpoch: metadata.epoch,
      lastCommit: metadata.commit,
    });
  }
}

function resolveRepository (origin) {
  if (!origin) return undefined;
  if (origin.worktree) return { mode: 'worktree', location: origin.worktree };
  if (origin.gitdir) return { mode: 'gitdir', location: origin.gitdir };
  return undefined;
}

function resolveGitReference (origin) {
  return origin.commit || origin.refhash || origin.refname || origin.branch || 'HEAD';
}

function resolveRepositoryPath (sourcePath, startPath) {
  const normalizedSourcePath = normalizeResourcePath(sourcePath).replace(/^\/+/, '');
  const normalizedStartPath = normalizeResourcePath(startPath).replace(/^\/+|\/+$/g, '');
  return normalizedStartPath ? `${normalizedStartPath}/${normalizedSourcePath}` : normalizedSourcePath;
}

function loadRepositoryHistory (repository, reference) {
  const args = repository.mode === 'worktree'
    ? ['-C', repository.location]
    : [`--git-dir=${repository.location}`];

  args.push('log', reference, '--name-only', '--format=COMMIT%x09%H%x09%cI%x09%ct', '--');

  const result = spawnSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 100 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) return new Map();
  return parseGitHistory(result.stdout);
}

function parseGitHistory (output) {
  const history = new Map();
  let current;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('COMMIT\t')) {
      const [, commit, timestamp, epoch] = line.split('\t');
      current = { commit, timestamp, epoch: Number(epoch) };
      continue;
    }

    if (current) {
      const filePath = normalizeResourcePath(line);
      if (!history.has(filePath)) history.set(filePath, current);
    }
  }

  return history;
}

function isCatalogPageIncluded (page, includeComponents) {
  if (!includeComponents) return true;
  return includeComponents.some((entry) => {
    if (entry.name !== page.src.component) return false;
    if (entry.versions && !entry.versions.has(page.src.version)) return false;
    if (entry.modules && !entry.modules.has(page.src.module)) return false;
    return true;
  });
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
  if (value === undefined || value === null || value === false) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '' || normalized === 'true' || normalized === 'yes' || normalized === '1';
}

function getAttribute (contents, name) {
  const match = contents.match(new RegExp(`^:${escapeRegExp(name)}:[ \t]*(.*?)[ \t]*$`, 'm'));
  return match ? match[1] : undefined;
}

function getDocumentTitle (contents) {
  const match = contents.match(/^=\s+(.+?)\s*$/m);
  return match ? match[1].trim() : undefined;
}

function getFileContents (file) {
  const contents = file.contents || file._contents;
  if (!contents) return '';
  return Buffer.isBuffer(contents) ? contents.toString('utf8') : String(contents);
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
  if (!Array.isArray(components)) throw new Error('generated navigation extension: components must be an array');

  return components.map((entry) => {
    if (typeof entry === 'string') return { name: entry, versions: null, modules: null };
    if (!entry || typeof entry !== 'object' || !entry.name) {
      throw new Error('generated navigation extension: each component entry must be a string or an object with a name');
    }
    return { name: entry.name, versions: toSet(entry.versions), modules: toSet(entry.modules) };
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
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function normalizeResourcePath (value) {
  return String(value || '').split(path.sep).join('/');
}

function toDisplayTitle (value) {
  return String(value).replace(/\.adoc$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeLinkText (value) {
  return String(value).replace(/]/g, '\\]');
}

function escapeRegExp (value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
