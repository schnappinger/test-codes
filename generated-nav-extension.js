'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_ORDER = 9999;
const DEFAULT_NAV_FILE = 'generated-nav.adoc';
const MAX_LEVELS = 5;

module.exports.register = function register ({ config = {} } = {}) {
  const navFile = config.navFile || DEFAULT_NAV_FILE;
  const maxLevels = normalizeMaxLevels(config.maxLevels || MAX_LEVELS);
  const componentRules = normalizeComponentRules(config.components);

  this.on('contentAggregated', ({ contentAggregate }) => {
    if (!Array.isArray(contentAggregate)) {
      throw new Error('generated navigation extension: contentAggregate is unavailable');
    }

    const historyCache = new Map();

    for (const componentVersion of contentAggregate) {
      if (!componentMatches(componentVersion, componentRules)) continue;

      injectGitAttributes(componentVersion, componentRules, historyCache);
      generateNavigation(componentVersion, componentRules, navFile, maxLevels);
    }
  });
};

function injectGitAttributes (componentVersion, rules, historyCache) {
  for (const file of componentVersion.files || []) {
    const pageInfo = getPageInfo(file);
    if (!pageInfo || !moduleMatches(componentVersion, pageInfo.module, rules)) continue;

    const origin = file.src && file.src.origin;
    const repository = resolveRepository(origin);
    if (!repository) continue;

    const reference = resolveGitReference(origin);
    const cacheKey = `${repository.mode}|${repository.location}|${reference}`;

    if (!historyCache.has(cacheKey)) {
      historyCache.set(cacheKey, loadRepositoryHistory(repository, reference));
    }

    const repositoryPath = resolveRepositoryPath(file.src.path, origin && origin.startPath);
    const metadata = historyCache.get(cacheKey).get(repositoryPath);
    if (!metadata) continue;

    const contents = setPageAttributes(getFileContents(file), {
      'page-last-modified': metadata.timestamp,
      'page-last-modified-epoch': metadata.epoch,
      'page-last-commit': metadata.commit,
    });

    setFileContents(file, contents);
  }
}

function generateNavigation (componentVersion, rules, navFile, maxLevels) {
  const pagesByModule = new Map();

  for (const file of componentVersion.files || []) {
    const pageInfo = getPageInfo(file);
    if (!pageInfo || !moduleMatches(componentVersion, pageInfo.module, rules)) continue;

    const contents = getFileContents(file);
    if (isNavExcluded(contents)) continue;

    const page = {
      file,
      relative: pageInfo.relative,
      title: getPageTitle(contents, pageInfo.relative),
      order: getPageOrder(contents),
    };

    if (!pagesByModule.has(pageInfo.module)) pagesByModule.set(pageInfo.module, []);
    pagesByModule.get(pageInfo.module).push(page);
  }

  for (const [moduleName, pages] of pagesByModule) {
    if (pages.length === 0) continue;

    const tree = createDirectoryNode('', DEFAULT_ORDER);
    for (const page of pages) addPageToTree(tree, page, maxLevels);
    updateDirectoryOrders(tree);

    const navLines = renderNav(tree, 1, maxLevels);
    if (navLines.length > 0) addGeneratedNavFile(componentVersion, moduleName, navFile, navLines, pages[0].file);
  }
}

function getPageInfo (file) {
  const sourcePath = normalizePath(file.src && file.src.path);
  const match = sourcePath.match(/^modules\/([^/]+)\/pages\/(.+\.adoc)$/);
  return match ? { module: match[1], relative: match[2] } : undefined;
}

function setPageAttributes (contents, attributes) {
  let result = contents;

  for (const [name, value] of Object.entries(attributes)) {
    const line = `:${name}: ${value}`;
    const pattern = new RegExp(`^:${escapeRegExp(name)}:[ \\t]*.*$`, 'm');

    if (pattern.test(result)) result = result.replace(pattern, line);
  }

  const missingLines = Object.entries(attributes)
    .filter(([name]) => !new RegExp(`^:${escapeRegExp(name)}:`, 'm').test(result))
    .map(([name, value]) => `:${name}: ${value}`);

  if (missingLines.length === 0) return result;

  const titleMatch = result.match(/^(?:\uFEFF)?=\s+.+?(\r?\n)/);
  if (!titleMatch) return `${missingLines.join('\n')}\n${result}`;

  const position = titleMatch[0].length;
  return `${result.slice(0, position)}${missingLines.join('\n')}\n${result.slice(position)}`;
}

function setFileContents (file, contents) {
  const buffer = Buffer.from(contents, 'utf8');
  if (Object.prototype.hasOwnProperty.call(file, '_contents')) file._contents = buffer;
  else file.contents = buffer;
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
  const source = normalizePath(sourcePath).replace(/^\/+/, '');
  const start = normalizePath(startPath).replace(/^\/+|\/+$/g, '');
  return start ? `${start}/${source}` : source;
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
    } else if (current) {
      const filePath = normalizePath(line);
      if (!history.has(filePath)) history.set(filePath, current);
    }
  }

  return history;
}

function addPageToTree (root, page, maxLevels) {
  const segments = normalizePath(page.relative).split('/').filter(Boolean);
  if (segments.length === 0) return;

  const fileStem = path.basename(segments.at(-1), '.adoc');
  const directories = segments.slice(0, -1);
  const isFolderIndex = directories.length > 0 && fileStem === directories.at(-1);
  const visibleDirectories = directories.slice(0, Math.max(maxLevels - 1, 0));
  const overflowDirectories = directories.slice(Math.max(maxLevels - 1, 0));

  let current = root;
  for (const directory of visibleDirectories) {
    const key = `dir:${directory}`;
    if (!current.children.has(key)) current.children.set(key, createDirectoryNode(toDisplayTitle(directory), DEFAULT_ORDER));
    current = current.children.get(key);
  }

  if (isFolderIndex && overflowDirectories.length === 0) {
    current.page = { title: page.title, order: page.order, xref: page.relative };
    current.title = page.title;
    return;
  }

  const title = overflowDirectories.length
    ? `${overflowDirectories.map(toDisplayTitle).join(' / ')} / ${page.title}`
    : page.title;

  current.children.set(`file:${page.relative}`, {
    type: 'file', title, order: page.order, xref: page.relative,
  });
}

function createDirectoryNode (title, order) {
  return { type: 'directory', title, order, page: null, children: new Map() };
}

function updateDirectoryOrders (node) {
  let lowest = node.page ? node.page.order : DEFAULT_ORDER;
  for (const child of node.children.values()) {
    const order = child.type === 'directory' ? updateDirectoryOrders(child) : child.order;
    lowest = Math.min(lowest, order);
  }
  node.order = lowest;
  return lowest;
}

function renderNav (node, level, maxLevels) {
  const lines = [];
  const children = [...node.children.values()].sort(compareEntries);

  for (const child of children) {
    const currentLevel = Math.min(level, maxLevels);
    const prefix = '*'.repeat(currentLevel);

    if (child.type === 'directory') {
      lines.push(child.page
        ? `${prefix} xref:${child.page.xref}[${escapeLinkText(child.page.title)}]`
        : `${prefix} ${child.title}`);
      lines.push(...renderNav(child, currentLevel + 1, maxLevels));
    } else {
      lines.push(`${prefix} xref:${child.xref}[${escapeLinkText(child.title)}]`);
    }
  }

  return lines;
}

function addGeneratedNavFile (componentVersion, moduleName, navFile, navLines, templateFile) {
  const navPath = `modules/${moduleName}/${navFile}`;
  const origin = templateFile.src && templateFile.src.origin;
  const cwd = templateFile.cwd || templateFile._cwd || process.cwd();
  const existingIndex = componentVersion.files.findIndex((file) => file.src && normalizePath(file.src.path) === navPath);
  if (existingIndex >= 0) componentVersion.files.splice(existingIndex, 1);

  componentVersion.files.push({
    cwd,
    base: templateFile.base || templateFile._base || cwd,
    path: navPath,
    contents: Buffer.from(`${navLines.join('\n')}\n`, 'utf8'),
    src: {
      abspath: origin && origin.worktree ? path.join(origin.worktree, navPath) : path.join(cwd, navPath),
      path: navPath,
      basename: navFile,
      stem: path.basename(navFile, '.adoc'),
      extname: '.adoc',
      origin,
    },
  });
}

function getPageTitle (contents, relative) {
  return firstNonBlank([
    getAttribute(contents, 'page-nav-title'),
    getAttribute(contents, 'navtitle'),
    getAttribute(contents, 'page-title'),
    (contents.match(/^=\s+(.+?)\s*$/m) || [])[1],
    toDisplayTitle(path.basename(relative, '.adoc')),
  ]);
}

function getPageOrder (contents) {
  const value = Number(getAttribute(contents, 'nav-order'));
  return Number.isFinite(value) ? value : DEFAULT_ORDER;
}

function isNavExcluded (contents) {
  const value = getAttribute(contents, 'nav-exclude');
  if (value === undefined) return false;
  return ['', 'true', 'yes', '1'].includes(String(value).trim().toLowerCase());
}

function getAttribute (contents, name) {
  const match = contents.match(new RegExp(`^:${escapeRegExp(name)}:[ \\t]*(.*?)[ \\t]*$`, 'm'));
  return match ? match[1] : undefined;
}

function getFileContents (file) {
  const contents = file.contents || file._contents;
  return Buffer.isBuffer(contents) ? contents.toString('utf8') : String(contents || '');
}

function normalizeComponentRules (components) {
  if (!components) return null;
  if (!Array.isArray(components)) throw new Error('components must be an array');
  return components.map((entry) => typeof entry === 'string'
    ? { name: entry, versions: null, modules: null }
    : { name: entry.name, versions: toSet(entry.versions), modules: toSet(entry.modules) });
}

function componentMatches (componentVersion, rules) {
  return !rules || rules.some((rule) => rule.name === componentVersion.name && (!rule.versions || rule.versions.has(componentVersion.version)));
}

function moduleMatches (componentVersion, moduleName, rules) {
  return !rules || rules.some((rule) => rule.name === componentVersion.name &&
    (!rule.versions || rule.versions.has(componentVersion.version)) &&
    (!rule.modules || rule.modules.has(moduleName)));
}

function toSet (value) {
  return value ? new Set(Array.isArray(value) ? value : [value]) : null;
}

function normalizeMaxLevels (value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_LEVELS) : MAX_LEVELS;
}

function compareEntries (a, b) {
  return a.order !== b.order ? a.order - b.order : a.title.localeCompare(b.title, 'de', { numeric: true, sensitivity: 'base' });
}

function firstNonBlank (values) {
  const value = values.find((entry) => entry !== undefined && entry !== null && String(entry).trim());
  return value === undefined ? '' : String(value).trim();
}

function normalizePath (value) {
  return String(value || '').split(path.sep).join('/');
}

function toDisplayTitle (value) {
  return String(value).replace(/\.adoc$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function escapeLinkText (value) {
  return String(value).replace(/]/g, '\\]');
}

function escapeRegExp (value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
