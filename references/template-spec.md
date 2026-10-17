# 模板规范（本地版 0.5.0）

网站由“模板 + 数据”生成。你写模板，决定网站长什么样；产品、新闻等内容存在 `content/` 里，由工具填进模板。模板语言是 **Liquid**。

**核心原则：模板里只写设计和界面文字（如“联系我们”“查看详情”），不写任何事实。** 产品名、新闻标题、规格、公司电话、公司介绍、优势都要通过变量输出。产品和新闻写死在模板里会被工具查出来报错；公司介绍这类写死了工具查不出来，但一样不允许，要放进 site.json 的 `extra`。

## 1. 模板目录

```text
theme/
  layouts/        页面外框（页头、导航、页脚），如 base.liquid
  partials/       可复用片段，如 product-card.liquid
  pages/          普通页面：一个文件就是一个页面
    index.liquid    首页（必须有）
    404.liquid      找不到页面时显示（必须有，系统页面）
    privacy.liquid  隐私政策（网站有询盘表单时必须有）
    about.liquid    → /about/
    contact.liquid  → /contact/
  columns/        栏目模板
    products/list.liquid    产品列表页
    products/detail.liquid  产品详情页
    news/list.liquid
    news/detail.liquid
    _default/list.liquid    某栏目没有专属模板时用这里的
    _default/detail.liquid
  assets/         CSS、JS、字体、设计用的图片（不是产品图）
```

产品图、工厂图等内容图片放在站点目录的 `images/` 下，不放在 `theme/assets/`。设计用的图片（背景、纹理、图标）放 `theme/assets/`。**两种图都只能用网站自己的文件**，不能写本机路径、`localhost` 地址或外部网站的图片地址；预览和发布用的是同一套地址，按规范写就不会出现“预览正常、发布丢图”。

## 2. 网址规则（工具自动生成，不要自己拼）

| 页面 | 默认语言 | 英文 |
|---|---|---|
| 首页 | `/` | `/en/` |
| 普通页面 | `/about/` | `/en/about/` |
| 栏目列表 | `/products/` | `/en/products/` |
| 列表第 2 页 | `/products/page/2/` | `/en/products/page/2/` |
| 分类列表 | `/products/category/<分类key>/` | `/en/products/category/<分类key>/` |
| 详情 | `/products/<slug>/` | `/en/products/<slug>/` |

链接一律用变量里的 `url`，例如 `{{ item.url }}`、`{{ columns.products.url }}`，不要手写网址，这样切换语言时链接自动正确。首页用 `{{ home_url }}`，联系页用 `{{ contact_url }}`，其他普通页面用 `{{ "/about/" | page_url }}`。不要按语言手拼路径；仅英文站或默认语言为英文时也需正确。

## 3. 页面开头的标题设置（只用于 pages/）

```liquid
---
title: 关于我们
title.en: About Us
description: 一句话介绍这一页
description.en: One sentence about this page
---
```

栏目页和详情页的标题由工具按内容自动生成，不用写。

## 4. 布局写法

`layouts/base.liquid`：

```liquid
<!doctype html>
<html lang="{{ lang }}">
<head>
  {% include 'yz/seo-head' %}
  <link rel="stylesheet" href="{{ 'site.css' | asset_url }}">
</head>
<body>
  <header>…导航…</header>
  <main>{% block content %}{% endblock %}</main>
  <footer>…</footer>
</body>
</html>
```

`pages/about.liquid`：

```liquid
{% layout 'base' %}
{% block content %}
  <h1>{{ "关于我们" | t: "About Us" }}</h1>
{% endblock %}
```

`<head>` 里必须有 `{% include 'yz/seo-head' %}`，它会输出 charset、viewport、标题、描述、多语言链接、网站图标。

## 5. 所有页面都能用的变量

| 变量 | 内容 |
|---|---|
| `home_url` `contact_url` | 当前语言的首页、联系页网址 |
| `lang` | 当前语言：`zh-CN` 或 `en` |
| `langs` | 当前页面的各语言版本，每项有 `code`、`name`（中文 / English）、`url`；用来做语言切换 |
| `site.name` `site.brand` `site.headline` | 公司名、品牌名、主标语（已按当前语言取好） |
| `site.logo` `site.favicon` | 图片路径，用 `| img` 输出 |
| `site.phone` `site.email` `site.address` `site.whatsapp` `site.wechat` | 联系方式 |
| `site.extra.<名称>` | “关于我们”这类页面上的事实：公司介绍、优势、发展历程、证书、备案号等，来自 site.json 的 `extra`，已按当前语言取好，例如 `{{ site.extra.intro }}`、`{% for s in site.extra.strengths %}` |
| `columns.<栏目key>` | 某个栏目，见下表，例如 `columns.products`、`columns.news` |
| `page.title` `page.description` `page.url` `page.kind` | 当前页信息；`kind` 是 `page`、`list`、`detail` |
| `preview` | 仅 build --demo 时为 true；普通本地构建为 false |

`columns.<栏目key>` 里有：

| 变量 | 内容 |
|---|---|
| `name` `url` | 栏目名称、列表页网址 |
| `items` | 本栏目全部要显示的内容，已排好序 |
| `count` | 条数 |
| `featured` | 标了“推荐”的内容 |
| `categories` | 分类，每项有 `key`、`name`、`url`、`count` |

首页取内容的常见写法：

```liquid
{% for p in columns.products.featured limit: 6 %}…{% endfor %}
{% for n in columns.news.items limit: 3 %}…{% endfor %}
```

## 6. 列表页变量（columns/*/list.liquid）

| 变量 | 内容 |
|---|---|
| `column` | 当前栏目（同上表） |
| `paginator.items` | 这一页要显示的内容 |
| `paginator.page` `paginator.pages` `paginator.total` | 第几页、共几页、共几条 |
| `paginator.prev_url` `paginator.next_url` | 上一页、下一页网址；没有时为空 |
| `category` | 分类列表页时是当前分类，否则为空 |

**列表页必须用 `{% for it in paginator.items %}` 循环输出全部内容**，不能只取第一条，也不能手写。分类列表页也用同一个列表模板。

## 7. 详情页变量（columns/*/detail.liquid）

| 变量 | 内容 |
|---|---|
| `column` | 当前栏目 |
| `item` | 当前这条内容，字段见下 |

每条内容（`item`，以及列表里的每一项）有：

| 字段 | 内容 |
|---|---|
| `title` `summary` | 标题、摘要 |
| `body` | 正文，经过轻量清理；只使用可信的整理结果，直接 `{{ item.body }}` 输出 |
| `cover` | 标题图路径，用 `{{ item.cover | img }}` |
| `date` | 显示日期，用 `{{ item.date | date_local }}` |
| `featured` | 是否推荐 |
| `category` | 分类，有 `name`、`url`；没有分类时为空 |
| `fields` | 旧项目兼容字段，新项目参数用正文表格。列表只含有值的，每项有 `label`、`value`；适合循环输出成参数表 |
| `field.<字段key>` | 旧项目兼容读取，例如 `item.field.model` |
| `url` | 这条内容的网址 |

**空值可以直接判断**：没有标题图时 `item.cover` 为空，`{% if item.cover %}` 就不成立。没有内容的区块（比如没有参数）不要显示空表格。

## 8. 过滤器

| 写法 | 作用 |
|---|---|
| `{{ "中文" | t: "English" }}` | 按当前语言显示固定文字，用于按钮、标题等界面文字 |
| `{{ 'site.css' | asset_url }}` | 引用 `theme/assets/` 下的文件；文件不存在会报错 |
| `{{ item.cover | img }}` | 引用 `images/` 下的内容图片；文件不存在会报错 |
| `{{ item.date | date_local }}` | 中文显示为“2026年10月16日”，英文显示为“Oct 16, 2026” |
| `{{ "/about/" | page_url }}` | 普通页面路径加当前语言前缀；默认语言在根路径 |
| `{{ x | escape }}` | 放进 HTML 属性里的文字要转义，如 `alt="{{ item.title | escape }}"` |

注释用 `{% comment %}…{% endcomment %}`，不要用 `{# #}`。Liquid 常用的 `limit`、`offset`、`size`、`truncate`、`upcase`、`default` 等都可以用。

## 9. 本地提供的片段

| 片段 | 用法 |
|---|---|
| `{% include 'yz/seo-head' %}` | 放在 `<head>` 里，必须有 |
| `{% include 'yz/inquiry-form' %}` | 询盘表单。**不要自己写 `<form>`**，固定姓名、电话、邮箱、国家，仅浏览器演示；不发送、不记录。平台接入后再替换版本化片段 |
| `{% include 'yz/privacy-text' %}` | 本地演示说明。放在 `pages/privacy.liquid`；正式接入时需采用平台确认的实际隐私说明 |

询盘表单的样式可以通过这些 class 调整：`.yz-form`、`.yz-field`、`.yz-label`、`.yz-consent`、`.yz-submit`、`.yz-form-result`；隐私政策正文的外层是 `.yz-privacy`。

## 10. 检查规则（`check`、`build`、`preview` 都会检查）

**错误（必须修复，否则不能生成）：**
- 模板里出现了某条内容的标题，说明把内容写死在模板里了。
- 某条要显示的内容在网站上没有任何链接能点到，通常是列表页没有循环输出全部内容。
- 缺少 `pages/index.liquid`、`pages/404.liquid`，或某栏目缺少列表、详情模板。
- 网站有询盘表单，却没有 `pages/privacy.liquid`，或它没用 `yz/privacy-text`。
- 模板语法错误、渲染失败（会给出文件和行号）。
- 引用的图片、资源文件不存在。
- 自己写了 `<form>`，或用了 `<base>` 标签。
- 图片和资源地址发布后会失效：本机文件地址（`file://`）、电脑上的路径（`/Users/…`、`C:\…`）、本机预览地址（`localhost`）。
- 引用了外部网站的图片、字体、样式（包括 CSS 里的 `url(…)`）。要先下载：设计用图放 `theme/assets/`，内容图片放 `images/`。指向外部网站的普通链接（`<a href>`）可以。
- 模板里直接写了 `/images/…` 路径。设计用图用 `asset_url`，内容图片用 `img` 过滤器从数据里输出。

**提醒（建议修复）：**
- 每页应正好有 1 个 `<h1>`；图片要有 `alt`；没有 `<title>`。
- 链接指向不存在的页面（完整 build 阶段会作为错误阻止输出）。
- 引用了外部网站的脚本。
- 出现像“示例产品”“lorem ipsum”这样的占位文字。
- 某条内容缺少英文标题，英文网站上就不会显示它。

## 11. 设计要求

- **先手机，后电脑**：客户的客户大多用手机看。在 375 像素宽的屏幕上不能横向滚动，按钮要够大。
- 全站风格统一：颜色、字体、间距、按钮写在一个 CSS 文件里，用 CSS 变量定义主色。
- 产品列表要能处理 1 条和 100 条两种情况：1 条时不能显得空，100 条时要分页、可按分类看。
- 内容可能缺：没有标题图、没有摘要、没有参数时，版面都不能乱。
- 中英文长度差很多，英文标题可能长三倍，不能撑破版面。
- 不引入外部字体和脚本，图片用 `loading="lazy"`。
