#!/usr/bin/env node
// 企业官网本地工具 0.5.0：生成、检查、预览、导出。需要 Node 18+。
// 不连接平台、不发布、不收集真实询盘；平台集成后仍在本地渲染。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Liquid } = require('./vendor/liquid.node.cjs');
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 18) fail('需要 Node 18 或更高版本');

const LANG_NAMES = { 'zh-CN': '中文', en: 'English' };
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const KEEP_RELEASES = 10;

// ---------- 通用 ----------
function fail(msg) { console.error('错误：' + msg); process.exit(1); }
function readJSON(file, fallback) {
  if (!fs.existsSync(file)) { if (fallback !== undefined) return fallback; fail('找不到文件 ' + file); }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fail(`${file} 不是合法的 JSON：${e.message}`); }
}
function writeJSON(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); }
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`不允许符号链接：${dir}`);
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`不允许符号链接：${p}`);
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}
function copyDir(src, dst) {
  for (const f of walk(src)) {
    const t = path.join(dst, path.relative(src, f));
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.copyFileSync(f, t);
  }
}
function rmDir(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function hashDir(dir) {
  const h = crypto.createHash('sha256');
  for (const f of walk(dir).sort()) { h.update(path.relative(dir, f)); h.update(fs.readFileSync(f)); }
  return h.digest('hex');
}
function today() { return new Date().toISOString().slice(0, 10); }
function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function parseArgs(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opt[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) opt[k] = argv[++i];
      else opt[k] = true;
    } else if (a === '-m') opt.m = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}

// ---------- 站点目录 ----------
class Site {
  constructor(dir) {
    this.dir = fs.realpathSync(path.resolve(dir));
    if (!fs.existsSync(path.join(this.dir, 'site.json'))) fail(`${this.dir} 不是站点目录（缺少 site.json）。先运行 init 创建，或用 --dir 指定站点目录。`);
    this.info = readJSON(this.p('site.json'));
    this.columns = readJSON(this.p('columns.json'), []);
    if (!Array.isArray(this.columns) || this.columns.some(c => !KEY_RE.test(c.key || '') || !SLUG_RE.test(c.path || ''))) fail('栏目 key 或 path 不合法');
    this.locales = this.info.locales?.length ? this.info.locales : ['zh-CN'];
    this.defaultLocale = this.info.default_locale || this.locales[0];
    const content = this.loadContent();
    for (const col of this.columns) {
      col.categories = col.categories || [];
      for (const it of content.filter(i => i._column === col.key && typeof i.category === 'string' && i.category)) {
        if (!col.categories.some(c => c.key === it.category || c.value === it.category)) col.categories.push({ key: 'c-' + digest(it.category).slice(0, 16), value: it.category, name: it.category });
      }
    }
  }
  p(...xs) { return inside(this.dir, ...xs); }
  column(key) { return this.columns.find(c => c.key === key); }
  loadContent() {
    const items = [];
    for (const col of this.columns) {
      const dir = this.p('content', col.key);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
        const file = path.join(dir, f);
        let data;
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (e) { items.push({ _file: file, _column: col.key, _parseError: e.message }); continue; }
        items.push({ ...data, _file: file, _column: col.key, slug: data.slug || f.replace(/\.json$/, '') });
      }
    }
    return items;
  }
}

// ---------- 渲染 ----------
const BUILTIN_PARTIALS = {
  'seo-head': `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ page.title | escape }}</title>
{% if page.description %}<meta name="description" content="{{ page.description | escape }}">{% endif %}
<link rel="canonical" href="{{ page.url }}">
{% for l in langs %}<link rel="alternate" hreflang="{{ l.code }}" href="{{ l.url }}">
{% endfor %}<meta property="og:title" content="{{ page.title | escape }}">
{% if page.image %}<meta property="og:image" content="{{ page.image }}">{% endif %}
{% if site.favicon %}<link rel="icon" href="/{{ site.favicon }}">{% endif %}`,
  'inquiry-form': `<form class="yz-form" data-yz-form autocomplete="off">
{% for f in form_fields %}<label class="yz-field yz-field-{{ f.key }}"><span class="yz-label">{{ f.label }}{% if f.required %} *{% endif %}</span>
{% if f.type == "textarea" %}<textarea name="{{ f.key }}"{% if f.required %} required{% endif %}></textarea>{% else %}<input name="{{ f.key }}" type="{{ f.type }}"{% if f.required %} required{% endif %}>{% endif %}
</label>
{% endfor %}<input type="text" name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
<p class="yz-consent">{{ form_consent }}<a href="{{ privacy_url }}">{{ form_privacy }}</a></p>
<button type="submit" class="yz-submit">{{ form_submit }}</button>
<p class="yz-form-result" hidden></p>
</form>
<script>(function(){var f=document.currentScript.previousElementSibling;f.addEventListener('submit',function(e){e.preventDefault();var m=f.querySelector('.yz-form-result');m.hidden=false;m.textContent=document.documentElement.lang==='en'?'Local preview only. Nothing was sent or saved.':'仅本地表单演示，信息未发送、未保存。';})})();</script>`,
};

BUILTIN_PARTIALS['privacy-text'] = `{% if lang == "en" %}<p>This is a local form preview. Form data is not sent or stored. The platform privacy notice must be supplied before production use.</p>{% else %}<p>当前为本地表单演示，填写的信息不会发送或保存。正式接入平台时需替换为与实际处理方式一致的隐私说明。</p>{% endif %}`;
const DEFAULT_FORM = [
  { key: 'name', type: 'text', required: true, label: { 'zh-CN': '姓名', en: 'Name' } },
  { key: 'phone', type: 'tel', required: false, label: { 'zh-CN': '电话', en: 'Phone' } },
  { key: 'email', type: 'email', required: true, label: { 'zh-CN': '邮箱', en: 'Email' } },
  { key: 'country', type: 'text', required: false, label: { 'zh-CN': '国家', en: 'Country' } },
];

const nz = (v) => (v === '' || v == null ? null : v);
// 把 { "zh-CN": ..., "en": ... } 这种按语言分开的值，取成当前语言的值（可嵌套在对象和数组里）
function localizeDeep(v, lang, fallback) {
  if (Array.isArray(v)) return v.map(x => localizeDeep(x, lang, fallback));
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length && keys.every(k => LANG_NAMES[k])) return nz(v[lang] ?? v[fallback] ?? null);
    return Object.fromEntries(keys.map(k => [k, localizeDeep(v[k], lang, fallback)]));
  }
  return nz(v);
}
function loc(v, lang, fallback) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return v[lang] ?? v[fallback] ?? '';
}
function sanitizeBody(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}
function parseFrontMatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([a-zA-Z_.-]+)\s*:\s*(.*)$/);
    if (mm) meta[mm[1]] = mm[2].trim();
  }
  return { meta, body: src.slice(m[0].length) };
}
function metaFor(meta, key, lang, defaultLocale) {
  if (lang !== defaultLocale && meta[`${key}.${lang.split('-')[0]}`]) return meta[`${key}.${lang.split('-')[0]}`];
  if (meta[`${key}.${lang}`]) return meta[`${key}.${lang}`];
  return meta[key] || '';
}

class Renderer {
  constructor(site, { mode, themeDir }) {
    this.site = site; this.mode = mode; this.themeDir = themeDir;
    this.errors = []; this.warnings = []; this.files = new Map();
    this.outDir = site.p('dist');
    const builtinDir = site.p('.yz', 'builtin');
    rmDir(builtinDir);
    for (const [k, v] of Object.entries(BUILTIN_PARTIALS)) {
      fs.mkdirSync(path.join(builtinDir, 'yz'), { recursive: true });
      fs.writeFileSync(path.join(builtinDir, 'yz', k + '.liquid'), v);
    }
    this.engine = new Liquid({
      root: [path.join(themeDir, 'partials'), path.join(themeDir, 'layouts'), builtinDir],
      partials: [path.join(themeDir, 'partials'), builtinDir],
      layouts: [path.join(themeDir, 'layouts')],
      extname: '.liquid', ownPropertyOnly: true, strictFilters: true, cache: false,
    });
    const self = this;
    this.engine.registerFilter('t', function (zh, en) { return this.context.getSync(['lang']) === 'en' ? (en ?? zh) : zh; });
    this.engine.registerFilter('page_url', function (p) { return self.url(this.context.getSync(['lang']), '/' + String(p || '').replace(/^\/+|\/+$/g, '') + (String(p || '').replace(/^\/+|\/+$/g, '') ? '/' : '')); });
    this.engine.registerFilter('asset_url', function (p) {
      const rel = String(p || '').replace(/^\/+/, '');
      if (!fs.existsSync(path.join(themeDir, 'assets', rel))) self.errors.push(`模板引用的资源不存在：theme/assets/${rel}`);
      return '/assets/' + rel;
    });
    this.engine.registerFilter('img', function (p) {
      if (!p) return '';
      const rel = String(p).replace(/^\/+/, '');
      if (!fs.existsSync(site.p(rel))) self.errors.push(`图片不存在：${rel}`);
      return '/' + rel;
    });
    this.engine.registerFilter('date_local', function (d) {
      if (!d) return '';
      const [y, m, day] = String(d).slice(0, 10).split('-');
      return this.context.getSync(['lang']) === 'en'
        ? new Date(`${y}-${m}-${day}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
        : `${y}年${Number(m)}月${Number(day)}日`;
    });
  }
  url(lang, p) { return (lang === this.site.defaultLocale ? '' : '/' + lang.split('-')[0]) + p; }

  visibleItems(all) {
    return all.filter(it => !it._parseError && it.visible === true);
  }
  localizeItem(it, lang, col) {
    const tr = it.i18n?.[lang];
    if (!tr || !tr.title) return null;
    const cat = (col.categories || []).find(c => c.key === it.category || c.value === it.category);
    const fieldDefs = col.fields || [];
    return {
      slug: it.slug, url: this.url(lang, `/${col.path}/${it.slug}/`),
      title: tr.title, summary: nz(tr.summary), body: nz(sanitizeBody(tr.body)),
      cover: nz(it.cover), date: nz(it.date), featured: !!it.featured,
      offline: false, sample: !!it.sample,
      category: cat ? { key: cat.key, name: loc(cat.name, lang, this.site.defaultLocale), url: this.url(lang, `/${col.path}/category/${cat.key}/`) } : null,
      fields: fieldDefs.map(f => ({ key: f.key, label: loc(f.label, lang, this.site.defaultLocale), value: tr.fields?.[f.key] ?? '' })).filter(f => f.value !== ''),
      field: Object.fromEntries(fieldDefs.map(f => [f.key, nz(tr.fields?.[f.key])])),
      seo_title: nz(tr.seo_title), seo_description: nz(tr.seo_description),
      sort: Number(it.sort || 0),
    };
  }
  buildData(lang, content) {
    const cols = {};
    for (const col of this.site.columns) {
      const raw = this.visibleItems(content.filter(it => it._column === col.key));
      const items = raw.map(it => this.localizeItem(it, lang, col)).filter(Boolean)
        .sort((a, b) => a.sort - b.sort || String(b.date).localeCompare(String(a.date)) || a.slug.localeCompare(b.slug));
      cols[col.key] = {
        key: col.key, name: loc(col.name, lang, this.site.defaultLocale), url: this.url(lang, `/${col.path}/`),
        items, count: items.length, featured: items.filter(i => i.featured),
        categories: (col.categories || []).map(c => ({ key: c.key, name: loc(c.name, lang, this.site.defaultLocale), url: this.url(lang, `/${col.path}/category/${c.key}/`), count: items.filter(i => i.category?.key === c.key).length })),
      };
    }
    const info = this.site.info;
    const siteVars = {
      name: loc(info.name, lang, this.site.defaultLocale), brand: nz(loc(info.brand, lang, this.site.defaultLocale)),
      headline: nz(loc(info.headline, lang, this.site.defaultLocale)), logo: nz(info.logo), favicon: nz(info.favicon),
      address: nz(loc(info.address, lang, this.site.defaultLocale)), email: nz(info.email), phone: nz(info.phone),
      whatsapp: nz(info.whatsapp), wechat: nz(info.wechat), extra: localizeDeep(info.extra || {}, lang, this.site.defaultLocale),
      default_locale: this.site.defaultLocale, locales: this.site.locales,
    };
    const formFields = DEFAULT_FORM
      .map(f => ({ key: f.key, type: f.type || 'text', required: !!f.required, label: loc(f.label, lang, this.site.defaultLocale) }));
    return {
      site: siteVars, lang, home_url: this.url(lang, '/'), contact_url: this.url(lang, '/contact/'), columns: cols, preview: this.mode === 'demo', form_fields: formFields,
      form_submit: lang === 'en' ? 'Test form' : '测试表单', privacy_url: this.url(lang, '/privacy/'),
      form_consent: lang === 'en' ? 'No information is sent or saved. ' : '不会发送或保存填写的信息。', form_privacy: lang === 'en' ? 'Preview notice' : '查看演示说明',
    };
  }
  langsFor(pathByLang) { return this.site.locales.filter(l => pathByLang[l]).map(l => ({ code: l, name: LANG_NAMES[l] || l, url: pathByLang[l] })); }

  async renderFile(tplFile, ctx, outPath) {
    const rel = path.relative(this.site.dir, tplFile);
    let src = fs.readFileSync(tplFile, 'utf8');
    src = parseFrontMatter(src).body;
    try {
      const html = await this.engine.parseAndRender(src, ctx);
      this.write(outPath, html);
      return true;
    } catch (e) {
      this.errors.push(`渲染 ${rel} 失败（生成 ${outPath} 时）：${e.message.split('\n')[0]}`);
      return false;
    }
  }
  write(outPath, content) {
    inside(this.outDir, outPath);
    if (outPath.split('/').includes('__site')) this.errors.push(`保留路径不能用作页面：${outPath}`);
    if (this.files.has(outPath)) this.errors.push(`页面路径重复：${outPath}`);
    this.files.set(outPath, content);
  }

  pickTemplate(colKey, kind) {
    const a = path.join(this.themeDir, 'columns', colKey, kind + '.liquid');
    if (fs.existsSync(a)) return a;
    const b = path.join(this.themeDir, 'columns', '_default', kind + '.liquid');
    if (fs.existsSync(b)) return b;
    return null;
  }

  async build() {
    const site = this.site; const content = site.loadContent();
    for (const it of content) if (it._parseError) this.errors.push(`内容文件不是合法 JSON：${path.relative(site.dir, it._file)}（${it._parseError}）`);
    const pagesDir = path.join(this.themeDir, 'pages');
    const pageFiles = walk(pagesDir).filter(f => f.endsWith('.liquid'));
    if (!pageFiles.length) this.errors.push('theme/pages/ 下没有任何页面模板');
    const expectedLinks = [];

    for (const lang of site.locales) {
      const base = this.buildData(lang, content);
      // 普通页面
      for (const f of pageFiles) {
        const relName = path.relative(pagesDir, f).replace(/\.liquid$/, '').split(path.sep).join('/');
        const { meta } = parseFrontMatter(fs.readFileSync(f, 'utf8'));
        if (relName === '404') {
          const out = lang === site.defaultLocale ? '404.html' : `${lang.split('-')[0]}/404.html`;
          const t = metaFor(meta, 'title', lang, site.defaultLocale) || (lang === 'en' ? 'Page not found' : '页面不存在');
          await this.renderFile(f, { ...base, page: { kind: 'page', name: '404', path: '/404', url: '', title: `${t} - ${base.site.name}` }, langs: [] }, out);
          continue;
        }
        const p = relName === 'index' ? '/' : `/${relName.replace(/\/index$/, '')}/`;
        const byLang = Object.fromEntries(site.locales.map(l => [l, this.url(l, p)]));
        const t = metaFor(meta, 'title', lang, site.defaultLocale);
        const title = relName === 'index' ? (t ? `${t}` : base.site.name) : `${t || relName} - ${base.site.name}`;
        await this.renderFile(f, { ...base, page: { kind: 'page', name: relName, path: p, url: byLang[lang], title, description: metaFor(meta, 'description', lang, site.defaultLocale) || base.site.headline || null }, langs: this.langsFor(byLang) }, this.url(lang, p).replace(/^\//, '') + 'index.html');
      }
      // 栏目
      for (const col of site.columns) {
        const c = base.columns[col.key];
        const listTpl = this.pickTemplate(col.key, 'list'); const detailTpl = this.pickTemplate(col.key, 'detail');
        if (!listTpl) { this.errors.push(`栏目「${c.name}」缺少列表模板：theme/columns/${col.key}/list.liquid`); }
        if (!detailTpl) { this.errors.push(`栏目「${c.name}」缺少详情模板：theme/columns/${col.key}/detail.liquid`); }
        const size = Number(col.page_size || 12);
        const renderList = async (items, basePath, extra) => {
          const pages = Math.max(1, Math.ceil(items.length / size));
          for (let n = 1; n <= pages; n++) {
            const p = n === 1 ? basePath : `${basePath}page/${n}/`;
            const byLang = Object.fromEntries(site.locales.map(l => [l, this.url(l, p)]));
            const paginator = {
              items: items.slice((n - 1) * size, n * size), page: n, pages, total: items.length,
              prev_url: n > 1 ? this.url(lang, n === 2 ? basePath : `${basePath}page/${n - 1}/`) : '',
              next_url: n < pages ? this.url(lang, `${basePath}page/${n + 1}/`) : '',
            };
            const title = `${extra.category ? extra.category.name + ' - ' : ''}${c.name} - ${base.site.name}`;
            if (listTpl) await this.renderFile(listTpl, { ...base, column: c, ...extra, paginator, page: { kind: 'list', path: p, url: byLang[lang], title, description: base.site.headline || null }, langs: this.langsFor(byLang) }, this.url(lang, p).replace(/^\//, '') + 'index.html');
          }
        };
        await renderList(c.items, `/${col.path}/`, {});
        for (const cat of c.categories) await renderList(c.items.filter(i => i.category?.key === cat.key), `/${col.path}/category/${cat.key}/`, { category: cat });
        for (const it of c.items) {
          const p = `/${col.path}/${it.slug}/`;
          const byLang = {};
          for (const l of site.locales) {
            const raw = content.find(x => x._column === col.key && x.slug === it.slug);
            if (raw?.i18n?.[l]?.title) byLang[l] = this.url(l, p);
          }
          const title = `${it.seo_title || it.title} - ${base.site.name}`;
          if (detailTpl) await this.renderFile(detailTpl, { ...base, column: c, item: it, page: { kind: 'detail', path: p, url: byLang[lang], title, description: it.seo_description || it.summary, image: it.cover ? '/' + it.cover : null }, langs: this.langsFor(byLang) }, this.url(lang, p).replace(/^\//, '') + 'index.html');
          expectedLinks.push({ url: it.url, title: it.title, col: c.name, offline: it.offline, sample: it.sample, key: col.key + '/' + it.slug });
        }
        const missing = content.filter(x => x._column === col.key && !x._parseError && x.visible === true && !x.i18n?.[lang]?.title);
        for (const x of missing) this.warnings.push(`「${c.name}」里的 ${x.slug} 没有${LANG_NAMES[lang] || lang}标题，${LANG_NAMES[lang] || lang}网站上不显示它`);
      }
    }
    if (!pageFiles.some(f => path.basename(f) === 'index.liquid' && path.dirname(f) === pagesDir)) this.errors.push('缺少首页模板：theme/pages/index.liquid');
    if (!pageFiles.some(f => path.basename(f) === '404.liquid')) this.errors.push('缺少 404 页面模板：theme/pages/404.liquid（这是系统页面，不出现在导航里，不能删）');
    const allTpl = walk(this.themeDir).filter(f => f.endsWith('.liquid')).map(f => fs.readFileSync(f, 'utf8'));
    if (allTpl.some(t => /include\s+['"]yz\/inquiry-form['"]/.test(t))) {
      const pv = path.join(pagesDir, 'privacy.liquid');
      if (!fs.existsSync(pv)) this.errors.push('网站有询盘表单，必须有隐私政策页：theme/pages/privacy.liquid，正文用 {% include \'yz/privacy-text\' %}');
      else if (!/include\s+['"]yz\/privacy-text['"]/.test(fs.readFileSync(pv, 'utf8'))) this.errors.push('theme/pages/privacy.liquid 的正文必须使用本地演示说明片段 {% include \'yz/privacy-text\' %}，不要自己写隐私条款');
    }

    this.postProcess(expectedLinks);
    return this;
  }

  postProcess(expectedLinks) {
    // 1. 每个内容都必须能从网站上点到（防止列表只显示一个或写死内容）
    // 只算 <a> 链接，并且不算这条内容自己的页面（含其他语言版本）指向自己
    const itemKeyOf = (u) => { const e = expectedLinks.find(x => x.url === u); return e ? e.key : null; };
    const linked = new Set();
    for (const [file, html] of this.files) {
      const selfKey = itemKeyOf('/' + file.replace(/index\.html$/, ''));
      for (const m of String(html).matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#?]+)/gi)) {
        const u = m[1].replace(/index\.html$/, '');
        if (selfKey && itemKeyOf(u) === selfKey) continue;
        linked.add(u);
      }
    }
    for (const e of expectedLinks) if (!linked.has(e.url)) this.errors.push(`「${e.col}」里的「${e.title}」在网站上没有任何链接指向它（列表页可能没有循环输出全部内容）：${e.url}`);
    // 2. 站内链接是否存在
    const exists = new Set([...this.files.keys()].map(f => '/' + f.replace(/index\.html$/, '')));
    const assets = new Set();
    for (const [file, html] of this.files) {
      for (const m of String(html).matchAll(/(?:href|src)\s*=\s*["'](\/[^"'#?]*)/gi)) {
        const u = m[1];
        if (u.startsWith('/assets/') || u.startsWith('/images/') || u.startsWith('/_api/')) { assets.add(u); continue; }
        if (u.startsWith('//')) continue;
        const norm = u.endsWith('/') || u.endsWith('.html') ? u.replace(/index\.html$/, '') : u + '/';
        if (!exists.has(norm) && !exists.has(u)) this.warnings.push(`${file} 里的链接指向不存在的页面：${u}`);
      }
      const h1 = (String(html).match(/<h1[\s>]/gi) || []).length;
      if (h1 !== 1 && !file.endsWith('404.html')) this.warnings.push(`${file} 有 ${h1} 个 <h1>，建议每页正好 1 个`);
      if (!/<title>[^<]+<\/title>/i.test(html)) this.warnings.push(`${file} 没有 <title>，请在 <head> 里加 {% include 'yz/seo-head' %}`);
      for (const m of String(html).matchAll(/<img\b[^>]*>/gi)) if (!/\balt\s*=\s*["'][^"']+/i.test(m[0])) { this.warnings.push(`${file} 有图片没有 alt 说明`); break; }
    }
    for (const u of assets) {
      const rel = u.replace(/^\//, '');
      const src = rel.startsWith('assets/') ? path.join(this.themeDir, rel) : rel.startsWith('images/') ? this.site.p(rel) : null;
      if (src && !fs.existsSync(decodeURIComponent(src))) this.errors.push(`页面引用的文件不存在：${u}`);
    }
    // 3. 生成后的页面兜底：不管地址来自模板还是数据
    for (const [file, html] of this.files) {
      for (const u of resourceRefs(html)) { const r = badRef(u); if (r) this.errors.push(`${file}：${u} 是${r}`); }
      for (const u of localLinks(html)) if (!resourceRefs(html).includes(u)) this.errors.push(`${file}：链接 ${u} 是${badRef(u, { allowExternal: true })}`);
    }
    // 示例构建有醒目标记，普通构建与本地服务使用同一份文件。
    if (this.mode === 'demo') {
      const banner = '<aside style="position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#8a281d;color:white;padding:10px;text-align:center">示例预览 · 不是正式网站 · 不可导出交付 / Demo only</aside>';
      for (const [f, html] of this.files) this.files.set(f, String(html).replace(/<\/body>/i, banner + '</body>'));
    }
  }

  writeOut() {
    fs.mkdirSync(this.outDir, { recursive: true });
    for (const [f, html] of this.files) { const t = path.join(this.outDir, f); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, html); }
    copyDir(path.join(this.themeDir, 'assets'), path.join(this.outDir, 'assets'));
    copyDir(this.site.p('images'), path.join(this.outDir, 'images'));
    const domain = (this.site.info.domain || 'https://example.com').replace(/\/$/, '');
    const urls = [...this.files.keys()].filter(f => f.endsWith('index.html')).map(f => domain + '/' + f.replace(/index\.html$/, ''));
    fs.writeFileSync(path.join(this.outDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${escHtml(u)}</loc></url>`).join('\n')}\n</urlset>\n`);
    fs.writeFileSync(path.join(this.outDir, 'robots.txt'), this.mode === 'demo' ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nAllow: /\nSitemap: ${domain}/sitemap.xml\n`);
  }
}

// ---------- 图片与资源地址 ----------
// 发布后会失效或不受平台控制的地址
function badRef(u, { allowExternal = false } = {}) {
  const v = String(u || '').trim();
  if (!v || v.startsWith('data:') || v.startsWith('#')) return null;
  if (/^file:/i.test(v)) return '本机文件地址（file://），发布后打不开';
  if (/^(https?:)?\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i.test(v)) return '本机预览地址（localhost），发布后打不开';
  if (/^(\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/|~\/|[A-Za-z]:[\\/])/.test(v)) return '电脑上的文件路径，发布后打不开';
  if (!allowExternal && /^(https?:)?\/\//i.test(v)) return '外部网站的图片或资源，要先下载到 images/ 或 theme/assets/ 再引用';
  return null;
}
// 找出 HTML/CSS 里所有“图片或资源”地址：img/source/video 的 src、srcset、poster，link 的 href，CSS 的 url()
function resourceRefs(text) {
  const out = []; const t = String(text || '');
  for (const m of t.matchAll(/<(?:img|source|video|audio|iframe|embed)\b[^>]*?\b(?:src|poster)\s*=\s*["']([^"']*)["']/gi)) out.push(m[1]);
  for (const m of t.matchAll(/\bsrcset\s*=\s*["']([^"']*)["']/gi)) for (const part of m[1].split(',')) out.push(part.trim().split(/\s+/)[0]);
  for (const m of t.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']*)["']/gi)) out.push(m[1]);
  for (const m of t.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) out.push(m[1]);
  return out.filter(u => !u.includes('{{') && !u.includes('{%'));
}
// 所有链接（含 <a>）里的本机地址
function localLinks(text) {
  return [...String(text || '').matchAll(/\b(?:href|src|action)\s*=\s*["']([^"']*)["']/gi)].map(m => m[1]).filter(u => badRef(u, { allowExternal: true }));
}
function checkImagePath(v, where, errors, site) {
  if (!v) return;
  const r = badRef(v); if (r) { errors.push(`${where}：${v} 是${r}`); return; }
  if (!/^\/?images\//.test(v)) { errors.push(`${where}：图片要放在 images/ 下，写成 images/… 的形式，现在是 ${v}`); return; }
  if (!fs.existsSync(site.p(v.replace(/^\//, '')))) errors.push(`${where}：图片不存在 ${v}`);
}

// ---------- 示例内容 ----------
// 普通构建不能包含示例；显式 demo 构建允许，但不允许导出。
function sampleBlockers(site, themeDir) {
  const out = [];
  if (walk(site.p('images', 'sample')).length) out.push('images/sample/ 仍有示例图片；替换后移至 materials/ 留档');
  const sf = site.info.sample_fields || [];
  if (sf.length) out.push(`公司信息还有示例内容：${sf.join('、')}（site.json 的 sample_fields）`);
  for (const k of ['logo', 'favicon']) if (String(site.info[k] || '').startsWith('images/sample/')) out.push(`site.json 的 ${k} 还是示例图片`);
  if (JSON.stringify(site.info.extra || {}).includes('images/sample/')) out.push('site.json 的 extra 里用了示例图片');
  for (const f of walk(themeDir)) if (/\.(liquid|html|css)$/.test(f) && fs.readFileSync(f, 'utf8').includes('images/sample/')) out.push(`设计模板用了示例图片：${path.relative(site.dir, f)}`);
  out.push(...sampleLikeText(site));
  for (const it of site.loadContent()) {
    if (it._parseError || !it.visible) continue;
    if (it.sample) out.push(`${it._column}/${it.slug} 是示例内容，不能用于普通构建`);
    else if (JSON.stringify(it).includes('images/sample/')) out.push(`${it._column}/${it.slug} 用了示例图片`);
  }
  return out;
}
// 兜底：没打示例标记、但文字看起来像示例或占位的
const SAMPLE_TEXT_RE = /示例|样例|演示数据|占位|\(sample\)|\bsample (content|data|text|address|intro|company)\b|\bdemo\b|placeholder|lorem ipsum|example\.(com|org|net)|0000-0000/i;
const SAMPLE_SRC_RE = /示例|sample|demo/i;
function looksSample(it) { return JSON.stringify(it.i18n || {}).match(SAMPLE_TEXT_RE) || JSON.stringify(it.sources || []).match(SAMPLE_SRC_RE); }
function sampleLikeText(site) {
  const out = [];
  const info = site.info; const sf = info.sample_fields || [];
  for (const k of ['name', 'brand', 'headline', 'address', 'email', 'phone', 'whatsapp', 'wechat']) {
    if (sf.includes(k)) continue;
    const m = JSON.stringify(info[k] ?? '').match(SAMPLE_TEXT_RE); if (m) out.push(`site.json 的 ${k} 看起来是示例（含“${m[0]}”），却没有列进 sample_fields`);
  }
  const ex = JSON.stringify(info.extra || {}).match(SAMPLE_TEXT_RE);
  if (ex && !sf.some(f => f.startsWith('extra'))) out.push(`site.json 的 extra 看起来有示例（含“${ex[0]}”）`);
  for (const it of site.loadContent()) {
    if (it._parseError || it.sample || !it.visible) continue;
    const m = looksSample(it); if (m) out.push(`${it._column}/${it.slug} 看起来是示例（含“${m[0]}”），却没有标 sample`);
  }
  return out;
}
// ---------- 检查 ----------
function checkSource(site, themeDir) {
  const errors = []; const warnings = [];
  const info = site.info;
  if (!loc(info.name, site.defaultLocale)) errors.push('site.json 缺少站点名称 name');
  for (const l of site.locales) if (!LANG_NAMES[l]) errors.push(`site.json 的 locales 只支持 zh-CN 和 en，现在有 ${l}`);
  if (!site.locales.includes(site.defaultLocale)) errors.push('site.json 的 default_locale 必须在 locales 里');
  for (const k of ['logo', 'favicon']) checkImagePath(info[k], `site.json 的 ${k}`, errors, site);
  (function scanExtra(v, where) {
    if (typeof v === 'string') { if (/\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i.test(v) || badRef(v, { allowExternal: true })) checkImagePath(v, where, errors, site); }
    else if (Array.isArray(v)) v.forEach((x, i) => scanExtra(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scanExtra(x, `${where}.${k}`);
  })(info.extra || {}, 'site.json 的 extra');
  if (info.form?.fields) errors.push('表单已固定为姓名、电话、邮箱、国家；删除旧 form.fields（migrate 会备份并移除）');
  const paths = new Set(); const keys = new Set();
  for (const col of site.columns) {
    if (keys.has(col.key)) errors.push(`栏目 key 重复：${col.key}`); keys.add(col.key);
    if (!KEY_RE.test(col.key || '')) errors.push(`columns.json 栏目 key 只能用小写字母、数字和下划线：${col.key}`);
    if (!SLUG_RE.test(col.path || '')) errors.push(`columns.json 栏目 ${col.key} 的 path 只能用小写字母、数字和短横线：${col.path}`);
    if (!Number.isInteger(Number(col.page_size)) || Number(col.page_size) < 1 || Number(col.page_size) > 1000) errors.push(`栏目 ${col.key} 的 page_size 必须为 1–1000 的整数`);
    if (paths.has(col.path)) errors.push(`columns.json 栏目路径重复：${col.path}`);
    paths.add(col.path);
    for (const f of col.fields || []) if (!KEY_RE.test(f.key || '') || ['title', 'cover', 'summary', 'body'].includes(f.key)) errors.push(`栏目 ${col.key} 的自定义字段 key 不合法：${f.key}`);
  }
  const content = site.loadContent();
  const titles = [];
  for (const it of content) {
    const rel = path.relative(site.dir, it._file);
    if (it._parseError) { errors.push(`${rel} 不是合法 JSON：${it._parseError}`); continue; }
    const col = site.column(it._column);
    if (!SLUG_RE.test(it.slug)) errors.push(`${rel}：slug 只能用小写字母、数字和短横线`);
    if (typeof it.visible !== 'boolean' || 'status' in it) errors.push(`${rel}：需要 visible 布尔值；旧项目先运行 migrate`);
    if (!it.id) errors.push(`${rel}：缺少稳定 id；旧项目先运行 migrate`);
    checkImagePath(it.cover, `${rel} 的标题图`, errors, site);
    if (it.category && typeof it.category !== 'string') errors.push(`${rel}：category 应为文本`);
    if (!it.i18n || !it.i18n[site.defaultLocale]?.title) errors.push(`${rel}：缺少默认语言（${site.defaultLocale}）的标题`);
    for (const [l, tr] of Object.entries(it.i18n || {})) {
      if (!site.locales.includes(l)) warnings.push(`${rel}：有 ${l} 内容，但站点没有启用这个语言`);
      if (tr.title && !tr.body && !tr.summary) warnings.push(`${rel}：${l} 只有标题，没有摘要和正文`);
      for (const k of Object.keys(tr.fields || {})) if (!(col.fields || []).some(f => f.key === k)) errors.push(`${rel}：字段 ${k} 没有在 columns.json 的栏目 ${col.key} 里定义`);
      if (tr.title) titles.push({ title: tr.title, rel });
      for (const u of resourceRefs(tr.body)) checkImagePath(u, `${rel} 的${LANG_NAMES[l] || l}正文`, errors, site);
      for (const u of localLinks(tr.body)) if (!resourceRefs(tr.body).includes(u)) errors.push(`${rel} 的${LANG_NAMES[l] || l}正文：链接 ${u} 是${badRef(u, { allowExternal: true })}`);
    }
    if (it.sample) { warnings.push(`${rel}：是示例内容，正式上线前要换成真实资料`); continue; }
    if (col && ['products'].includes(col.key) && !(it.sources || []).length) warnings.push(`${rel}：没有记录资料来源（sources），无法核对是否编造`);
  }
  const ids = new Set();
  for (const it of content) { if (it.id && ids.has(it.id)) errors.push(`内容 id 重复：${it.id}`); ids.add(it.id); }
  const seen = new Set();
  for (const it of content) { const k = it._column + '/' + it.slug; if (seen.has(k)) errors.push(`内容重复：${k}`); seen.add(k); }
  // 模板
  const tpls = walk(themeDir).filter(f => /\.(liquid|html)$/.test(f));
  const engine = new Liquid({ extname: '.liquid' });
  for (const f of tpls) {
    const rel = path.relative(site.dir, f); const src = fs.readFileSync(f, 'utf8');
    try { engine.parse(parseFrontMatter(src).body); } catch (e) { errors.push(`${rel} 语法错误：${e.message.split('\n')[0]}`); }
    for (const t of titles) {
      const minLen = /[一-龥]/.test(t.title) ? 4 : 10;
      if (t.title.length >= minLen && src.includes(t.title)) errors.push(`${rel} 把内容写死在模板里了：「${t.title}」（来自 ${t.rel}）。模板只能用变量输出内容`);
    }
    if (/<base\b/i.test(src)) errors.push(`${rel}：不允许使用 <base> 标签`);
    for (const u of resourceRefs(src)) {
      const r = badRef(u, { allowExternal: false });
      if (r) errors.push(`${rel}：${u} 是${r}`);
      else if (/^\/?images\//.test(u)) errors.push(`${rel}：模板里直接写了内容图片路径 ${u}。设计用的图放 theme/assets/ 并用 asset_url；内容图片用 {{ … | img }} 输出`);
    }
    for (const u of localLinks(src)) if (!resourceRefs(src).includes(u)) errors.push(`${rel}：链接 ${u} 是${badRef(u, { allowExternal: true })}`);
    for (const m of src.matchAll(/<form\b[^>]*>/gi)) if (!/data-yz-form/.test(m[0]) && !/action\s*=\s*["']\/_api\/inquiries/.test(m[0])) errors.push(`${rel}：表单只能用 {% include 'yz/inquiry-form' %}，不要自己写 <form>`);
    for (const m of src.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:)?\/\/([^/"']+)/gi)) warnings.push(`${rel}：引用了外部脚本 ${m[2]}，正式版默认不允许`);
    if (/lorem ipsum|示例产品|示例新闻|产品名称\d|xxx公司/i.test(src)) warnings.push(`${rel}：好像有占位文字，正式网站上不能出现`);
  }
  for (const f of walk(path.join(themeDir, 'assets')).filter(f => f.endsWith('.css'))) {
    const rel = path.relative(site.dir, f);
    for (const u of resourceRefs(fs.readFileSync(f, 'utf8'))) { const r = badRef(u); if (r) errors.push(`${rel}：${u} 是${r}`); }
  }
  for (const k of ['name', 'brand', 'headline', 'address', 'email', 'phone']) {
    if ((info.sample_fields || []).includes(k)) continue;
    const m = JSON.stringify(info[k] ?? '').match(SAMPLE_TEXT_RE); if (m) warnings.push(`site.json 的 ${k} 看起来是示例（含“${m[0]}”），是示例的话请列进 sample_fields`);
  }
  for (const it of content) {
    if (it._parseError || it.sample) continue;
    const m = looksSample(it); if (m) warnings.push(`${path.relative(site.dir, it._file)} 看起来是示例（含“${m[0]}”），是示例的话请标 "sample": true`);
  }
  if ((info.sample_fields || []).length) warnings.push(`公司信息里还有示例：${info.sample_fields.join('、')}，正式上线前要换成真实资料`);
  return { errors, warnings };
}

function report(label, errors, warnings) {
  if (errors.length) { console.log(`\n✗ ${label}发现 ${errors.length} 个错误（必须修复）：`); errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`)); }
  if (warnings.length) { console.log(`\n! ${label}有 ${warnings.length} 个提醒：`); [...new Set(warnings)].slice(0, 40).forEach((e, i) => console.log(`  ${i + 1}. ${e}`)); }
  if (!errors.length) console.log(`\n✓ ${label}没有错误`);
}

async function runBuild(site, mode, themeDir) {
  const src = checkSource(site, themeDir);
  if (src.errors.length) return { r: null, ...src };
  const r = await new Renderer(site, { mode, themeDir }).build();
  const errors = [...src.errors, ...r.errors]; const warnings = [...src.warnings, ...r.warnings];
  return { r, errors, warnings };
}

function pageSummary(site, files) {
  const count = (re) => [...files.keys()].filter(f => re.test(f)).length;
  const lines = [];
  for (const col of site.columns) {
    const n = [...files.keys()].filter(f => new RegExp(`(^|/)${col.path}/(?!page/|category/)[^/]+/index\\.html$`).test(f)).length;
    lines.push(`${loc(col.name, site.defaultLocale)} 详情页 ${n} 个`);
  }
  return `共生成 ${count(/\.html$/)} 个页面${lines.length ? `（${lines.join('，')}）` : ''}`;
}

function inside(root, ...parts) {
  const target = path.resolve(root, ...parts);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('路径越界：' + parts.join('/'));
  let current = root;
  for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('不允许符号链接：' + current);
  }
  return target;
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function toolHash() { return digest(fs.readFileSync(fileURLToPath(import.meta.url)) + '\n' + fs.readFileSync(path.join(TOOL_DIR,'vendor/liquid.node.cjs'))); }
function sourceHash(site) {
  const files = ['site.json', 'columns.json'].map(f => site.p(f));
  for (const dir of ['content', 'theme', 'images']) files.push(...walk(site.p(dir)));
  return digest(JSON.stringify(files.sort().map(f => {
    if (fs.lstatSync(f).isSymbolicLink()) throw new Error('不允许符号链接：' + f);
    return [path.relative(site.dir, f), digest(fs.readFileSync(f))];
  })));
}
function manifest(root) {
  return walk(root).sort().map(f => ({ path: path.relative(root, f).split(path.sep).join('/'), bytes: fs.statSync(f).size, sha256: digest(fs.readFileSync(f)) }));
}
function validateOutput(root) {
  const files = walk(root); const errors = [];
  for (const f of files) {
    if (!/\.(html|css)$/.test(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const refs = resourceRefs(text).map(url => ({ url, resource: true }));
    if (f.endsWith('.html')) {
      for (const m of text.matchAll(/<(a|script)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) refs.push({ url: m[2], resource: m[1].toLowerCase() === 'script' });
    }
    if (f.endsWith('.css')) for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) refs.push({url:m[1], resource:true});
    for (const { url, resource } of refs) {
      if (!url || url.startsWith('#') || url.startsWith('data:')) continue;
      if (!resource && /^(https?:|mailto:|tel:)/i.test(url)) continue;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) { errors.push(`不支持的资源地址：${url}`); continue; }
      try {
        const decoded = decodeURIComponent(url.split(/[?#]/)[0]);
        const target = inside(root, decoded.startsWith('/') ? decoded.slice(1) : path.join(path.relative(root, path.dirname(f)), decoded));
        const candidates = [target, path.join(target, 'index.html')];
        if (!candidates.some(t => fs.existsSync(t) && fs.statSync(t).isFile())) errors.push(`${path.relative(root,f)} 引用缺失：${url}`);
      } catch (e) { errors.push(e.message); }
    }
  }
  return [...new Set(errors)];
}
function currentBuild(site) {
  const b = readJSON(site.p('.yz', 'build.json'), null);
  if (!b || !fs.existsSync(site.p('dist'))) throw new Error('先运行 build 生成 dist');
  if (b.tool_hash !== toolHash()) throw new Error('生成工具已变化，请重新 build');
  if (sourceHash(site) !== b.source_hash) throw new Error('源文件已变化，请重新 build 后再预览或导出');
  if (JSON.stringify(manifest(site.p('dist'))) !== JSON.stringify(b.files)) throw new Error('dist 文件与生成记录不一致，请重新 build');
  return b;
}
async function buildLocal({site, opt}) {
  const initial = sourceHash(site);
  const mode = opt.demo ? 'demo' : 'build';
  const { r, errors, warnings } = await runBuild(site, mode, site.p('theme'));
  if (!opt.demo) errors.push(...sampleBlockers(site, site.p('theme')));
  report('本地生成', errors, warnings);
  if (errors.length) { process.exitCode = 2; return; }
  const stage = site.p('.yz', 'build-' + crypto.randomUUID());
  const old = site.p('.yz', 'previous-dist-' + crypto.randomUUID());
  try {
    r.outDir = stage; r.writeOut();
    const missing = validateOutput(stage);
    if (missing.length) { report('完整静态包检查', missing, []); process.exitCode = 2; return; }
    if (sourceHash(site) !== initial) throw new Error('生成期间源文件变化，请重试');
    const files = manifest(stage);
    const state = { schema_version: 1, tool_version: '0.5.0', tool_hash: toolHash(), mode, source_hash: initial, design_hash: hashDir(site.p('theme')), package_hash: digest(JSON.stringify(files)), form_mode: 'local-demo', platform_ready: false, files };
    const dist = site.p('dist');
    if (fs.existsSync(dist)) fs.renameSync(dist, old);
    try { fs.renameSync(stage, dist); writeJSON(site.p('.yz', 'build.json'), state); }
    catch (e) { rmDir(dist); if (fs.existsSync(old)) fs.renameSync(old, dist); throw e; }
    rmDir(old);
    console.log(`已生成 dist/：${pageSummary(site, r.files)}。${opt.demo ? '示例预览，不可导出。' : '可本地预览、导出；尚未发布。'}\n运行 serve 查看。表单仅本地演示，未接平台。`);
  } finally { rmDir(stage); }
}
function contentRef(site, ref) {
  const parts = ref.split('/');
  if (parts.length !== 2 || !site.column(parts[0]) || !SLUG_RE.test(parts[1])) throw new Error('内容引用应为 栏目/slug：' + ref);
  return site.p('content', parts[0], parts[1] + '.json');
}
function setVisible({site, pos, opt}, visible) {
  const files = opt.all ? site.loadContent().map(i => i._file) : pos.map(ref => contentRef(site, ref));
  if (!files.length) throw new Error('指定 栏目/slug 或 --all');
  const entries = files.map(f => [f, readJSON(f)]);
  if (entries.some(([,d]) => 'status' in d || typeof d.visible !== 'boolean')) throw new Error('旧项目先运行 migrate');
  for (const [f, d] of entries) { d.visible = visible; writeJSON(f,d); }
  console.log(`已修改 ${files.length} 条内容的草稿显示状态；重新 build 后生效，未发布。`);
}

const commands = {
  async init({ pos, opt }) {
    const dir = path.resolve(pos[0] || '.');
    if (fs.existsSync(path.join(dir, 'site.json'))) fail(`${dir} 已经是站点目录`);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) fail('init 需要新的或空的目录，不覆盖现有文件');
    fs.mkdirSync(dir, { recursive: true });
    const name = opt.name || '未命名公司';
    writeJSON(path.join(dir, 'site.json'), {
      name: { 'zh-CN': name }, brand: { 'zh-CN': '' }, headline: { 'zh-CN': '' }, address: { 'zh-CN': '' },
      logo: '', favicon: '', email: '', phone: '', whatsapp: '', wechat: '',
      locales: (opt.locales || 'zh-CN').split(','), default_locale: (opt.locales || 'zh-CN').split(',')[0],
      domain: '', extra: {},
    });
    writeJSON(path.join(dir, 'columns.json'), [
      { key: 'products', name: { 'zh-CN': '产品中心', en: 'Products' }, path: 'products', page_size: 12, builtin: true, fields: [], categories: [] },
      { key: 'news', name: { 'zh-CN': '新闻动态', en: 'News' }, path: 'news', page_size: 10, builtin: true, fields: [], categories: [] },
    ]);
    for (const d of ['content/products', 'content/news', 'materials', 'images', 'theme/layouts', 'theme/partials', 'theme/pages', 'theme/columns', 'theme/assets']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'facts.md'), `# ${name} · 官网资料表\n\n## 资料清单\n\n| 编号 | 类型 | 文件名或链接 | 收到时间 | 内容说明 |\n|---|---|---|---|---|\n\n## 事实表\n\n| 编号 | 类别 | 项目 | 内容 | 来源 | 状态 | 备注 |\n|---|---|---|---|---|---|---|\n`);
    const starter = opt.style === 'editorial' ? 'starter-editorial' : 'starter';
    const starterDir = path.join(TOOL_DIR, '..', 'assets', starter);
    if (!fs.existsSync(starterDir)) fail(`没有风格档 ${starter}（可选：starter、starter-editorial）`);
    copyDir(starterDir, dir);
    console.log(`已创建站点目录 ${dir}（风格档：${starter}）\n下一步：填写 site.json、columns.json，把资料放进 materials/，图片放进 images/，内容用 new 命令创建，设计写在 theme/。`);
  },

  async new({ pos, opt, site }) {
    const [colKey, slug] = pos; if (!colKey || !slug) fail('用法：new <栏目key> <slug> [--title 标题]');
    const col = site.column(colKey); if (!col) fail(`没有栏目 ${colKey}，现有：${site.columns.map(c => c.key).join('、')}`);
    if (!SLUG_RE.test(slug)) fail('slug 只能用小写字母、数字和短横线，例如 q41f-ball-valve');
    const file = site.p('content', colKey, slug + '.json');
    if (fs.existsSync(file)) fail(`已经有这条内容：${path.relative(site.dir, file)}`);
    const i18n = {};
    for (const l of site.locales) i18n[l] = { title: l === site.defaultLocale ? (opt.title || '') : '', summary: '', body: '', seo_title: '', seo_description: '', fields: Object.fromEntries((col.fields || []).map(f => [f.key, ''])) };
    writeJSON(file, { id: crypto.randomUUID(), slug, visible: true, sample: !!opt.sample, featured: false, date: today(), category: '', cover: '', sort: 0, sources: [], i18n });
    console.log(`已创建 ${path.relative(site.dir, file)}（草稿中显示${opt.sample ? '，示例内容' : ''}）。填好内容后运行 preview 查看。`);
  },

  async build(args) { await buildLocal(args); },
  async preview(args) { await buildLocal(args); },
  async check({site, opt}) {
    sourceHash(site);
    const {errors,warnings} = await runBuild(site, opt.demo ? 'demo' : 'build', site.p('theme'));
    if (!opt.demo) errors.push(...sampleBlockers(site,site.p('theme')));
    report('源文件检查',errors,warnings);
    if (errors.length) process.exitCode=2;
    else console.log('完整资源链接检查在 build 暂存目录中执行。');
  },
  async show(args) { setVisible(args,true); },
  async hide(args) { setVisible(args,false); },
  async delete({site,pos}) {
    if (!pos.length) throw new Error('指定 栏目/slug');
    const entries = pos.map(ref => [ref,contentRef(site,ref)]);
    for (const [,f] of entries) readJSON(f);
    for (const [ref,f] of entries) {
      const dest=site.p('.yz','trash',Date.now()+'-'+crypto.randomUUID()+'.json');
      writeJSON(dest,{ref,deleted_at:new Date().toISOString(),content:readJSON(f)}); fs.unlinkSync(f);
    }
    console.log('已从草稿删除；重新 build 后生效。可用 trash / undelete 恢复。');
  },
  async trash({site}) {
    const entries=walk(site.p('.yz','trash')).map(f=>readJSON(f));
    console.log(JSON.stringify(entries.map(({ref,deleted_at})=>({ref,deleted_at})),null,2));
  },
  async undelete({site,pos}) {
    if (!pos.length) throw new Error('指定 栏目/slug');
    for (const ref of pos) {
      const target=contentRef(site,ref);
      if(fs.existsSync(target)) throw new Error('已有同名内容，不覆盖：'+ref);
      const entries=walk(site.p('.yz','trash')).map(f=>({f,...readJSON(f)})).filter(d=>d.ref===ref).sort((a,b)=>b.deleted_at.localeCompare(a.deleted_at));
      if(!entries.length) throw new Error('回收站找不到：'+ref);
      const entry=entries[0];entry.content.visible=false;writeJSON(target,entry.content);fs.unlinkSync(entry.f);
    }
    console.log('已恢复到草稿，默认隐藏。show 后重新 build。');
  },
  async export({site,opt}) {
    if (!opt.out || typeof opt.out!=='string') throw new Error('用法：export --out 新的完整输出目录');
    const b=currentBuild(site);
    if(b.mode==='demo') throw new Error('示例构建不可导出；替换示例后运行 build');
    let target=path.resolve(opt.out);
    let ancestor=target;const tail=[];
    while(!fs.existsSync(ancestor)){tail.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);}
    target=path.join(fs.realpathSync(ancestor),...tail);
    if(target===site.dir || target.startsWith(site.dir+path.sep)) throw new Error('导出目录必须在站点工作空间外');
    if(fs.existsSync(target)) throw new Error('输出目录已存在，不覆盖：'+target);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    const temp=fs.mkdtempSync(path.join(path.dirname(target),'.yz-export-'));
    try {
      copyDir(site.p('dist'),path.join(temp,'dist'));
      if(JSON.stringify(manifest(path.join(temp,'dist')))!==JSON.stringify(b.files)) throw new Error('导出时文件变化，请重试');
      currentBuild(site);
      writeJSON(path.join(temp,'manifest.json'),b);
      fs.renameSync(temp,target);
    } finally { rmDir(temp); }
    console.log('已导出完整本地静态包：'+target+'\n包含 dist/ 与 manifest.json；未上传、未发布。表单和统计尚未接平台。');
  },
  async snapshot({site,opt}) {
    const note=opt.m||opt.note;if(typeof note!=='string'||!note.trim()) throw new Error('snapshot -m "设计说明"');
    const h=hashDir(site.p('theme')); const entries=readJSON(site.p('.yz','snapshots.json'),[]);
    if(entries.at(-1)?.design_hash===h) return console.log('设计未变化，沿用本地快照 '+entries.at(-1).version);
    const v=(entries.at(-1)?.version||0)+1;
    copyDir(site.p('theme'),site.p('.yz','snapshots','v'+v,'theme'));
    entries.push({version:v,note,design_hash:h,at:new Date().toISOString()});
    while(entries.length>KEEP_RELEASES){const old=entries.shift();rmDir(site.p('.yz','snapshots','v'+old.version));}
    writeJSON(site.p('.yz','snapshots.json'),entries);
    console.log('已保存本地设计快照 '+v+'；不是平台发布版本。');
  },
  async snapshots({site}) { console.log(JSON.stringify(readJSON(site.p('.yz','snapshots.json'),[]),null,2)); },
  async restore({site,pos}) {
    const v=Number(String(pos[0]||'').replace(/^v/,''));
    const entry=readJSON(site.p('.yz','snapshots.json'),[]).find(x=>x.version===v);
    if(!entry) throw new Error('本地设计快照不存在；用 snapshots 查看');
    const src=site.p('.yz','snapshots','v'+v,'theme');if(hashDir(src)!==entry.design_hash) throw new Error('快照文件不完整');
    const backup=site.p('.yz','design-backups',crypto.randomUUID());copyDir(site.p('theme'),backup);
    rmDir(site.p('theme'));copyDir(src,site.p('theme'));
    console.log('已恢复设计；保留当前内容、栏目、图片。旧设计不兼容当前栏目时需补模板。重新 build；原设计备份在 '+backup);
  },
  async status({site}) {
    for(const col of site.columns){const all=site.loadContent().filter(i=>i._column===col.key);console.log(`${loc(col.name,site.defaultLocale)}：${all.length} 条，显示 ${all.filter(i=>i.visible===true).length} 条，示例 ${all.filter(i=>i.sample).length} 条`);}
    try {const b=currentBuild(site);console.log('dist 与当前源文件一致；模式：'+b.mode);}catch(e){console.log(e.message);}
    console.log('仅本地工作空间；平台状态未接入。');
  },
  async migrate({site}) {
    sourceHash(site);
    const pending=[];
    for(const it of site.loadContent()){
      if(it._parseError) throw new Error('先修复 JSON：'+it._file);
      const d=readJSON(it._file);let changed=false;
      if(!d.id){d.id=crypto.randomUUID();changed=true;}
      if('status' in d){if(!['online','offline'].includes(d.status))throw new Error('未知旧状态：'+d.status);if(typeof d.visible!=='boolean')d.visible=d.status==='online';delete d.status;changed=true;}
      if(typeof d.visible!=='boolean'){d.visible=true;changed=true;}
      if(changed)pending.push([it._file,d]);
    }
    const info=readJSON(site.p('site.json'));
    if(info.form?.fields){delete info.form.fields;pending.push([site.p('site.json'),info]);}
    if(!pending.length)return console.log('无需迁移。');
    const backup=site.p('.yz','migration-backups',crypto.randomUUID());
    for(const [f] of pending){const dst=path.join(backup,path.relative(site.dir,f));fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(f,dst);}
    for(const [f,d] of pending)writeJSON(f,d);
    console.log('已迁移 '+pending.length+' 个文件；原 online→显示、offline→隐藏；旧 preview/live 保留但不再使用。备份：'+backup+'。需要显示的旧草稿用 show，再 build。');
  },
  async serve({site,opt,pos}) {
    if(pos.length) throw new Error('新版只预览 dist：serve [--port 8080]');
    currentBuild(site);const root=fs.realpathSync(site.p('dist'));const port=Number(opt.port??8080);
    if(!Number.isInteger(port)||port<0||port>65535)throw new Error('端口不合法');
    const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.gif':'image/gif','.xml':'application/xml','.txt':'text/plain; charset=utf-8','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.pdf':'application/pdf'};
    const server=http.createServer((req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Robots-Tag','noindex, nofollow');
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end('Local preview: no submissions accepted');}
      try {
        const u=new URL(req.url,'http://local');let rel=decodeURIComponent(u.pathname).replace(/^\//,'');
        if(rel.split('/').some(x=>x.startsWith('.')||x==='__site')){res.writeHead(403);return res.end('Forbidden');}
        if(!rel||rel.endsWith('/'))rel+='index.html';else if(!path.extname(rel)){
          res.writeHead(302,{Location:u.pathname+'/'+u.search});return res.end();
        }
        let file=inside(root,rel);let code=200;
        if(!fs.existsSync(file)||!fs.statSync(file).isFile()){file=inside(root,u.pathname.startsWith('/en/')?'en/404.html':'404.html');code=404;}
        if(!fs.existsSync(file)){res.writeHead(404);return res.end('Not found');}
        inside(root,path.relative(root,fs.realpathSync(file)));
        res.writeHead(code,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});
        if(req.method==='HEAD')return res.end();
        fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
      } catch {res.writeHead(400);res.end('Invalid path');}
    });
    server.on('error',e=>{console.error(e.message);process.exitCode=1;});
    server.listen(port,'127.0.0.1',()=>console.log(`本地预览：http://127.0.0.1:${server.address().port}/（仅本机，未发布；Ctrl+C 停止）`));
  },
  async help(){console.log(`官网本地工具 0.5.0 · Node 18+
用法：node yz.mjs <命令> --dir 站点完整路径
init <目录> --name 公司名 [--locales zh-CN,en] [--style starter|starter-editorial]  创建带基础模板的工作空间
new <栏目> <slug> --title 标题 [--sample]     新增草稿，默认显示
check [--demo]                              检查源文件
build / preview [--demo]                    生成唯一 dist；示例模式不可导出
serve [--port 8080]                         只读本机预览，不重新生成
show / hide <栏目/slug ...> [--all]          草稿显示/隐藏，需重新生成
delete / undelete <栏目/slug ...>            草稿删除/恢复
trash / status                             回收站 / 本地状态
export --out 新目录完整路径                 导出 dist 和摘要清单，不重新生成
snapshot -m "说明" / snapshots              保存 / 查看本地设计快照（保留10份）
restore <编号>                             恢复设计，保留当前内容
migrate                                    备份并迁移 0.4 的状态字段
平台尚未接入：不支持 publish、online、offline、refresh、releases、leads、visits、demo-data。`);},
};
const [cmd='help',...rest]=process.argv.slice(2);
const args=parseArgs(rest);
try {
  const deprecated=['publish','online','offline','refresh','releases','leads','visits','demo-data'];
  if(deprecated.includes(cmd))throw new Error(`旧命令 ${cmd} 已停用；运行 help 查看本地命令。没有上传或发布任何内容。`);
  if(!Object.hasOwn(commands,cmd))throw new Error('未知命令：'+cmd);
  if(!['init','help'].includes(cmd))args.site=new Site(args.opt.dir||'.');
  await commands[cmd](args);
}catch(e){console.error('错误：'+e.message);process.exitCode=1;}
