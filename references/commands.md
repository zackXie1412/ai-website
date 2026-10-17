# 工作空间与命令 · 0.5.0

需要 Node 18+，Liquid 已随包提供，无需安装网络依赖。
运行：`node <技能目录>/tools/yz.mjs <命令> --dir <站点绝对路径>`。init 的目录是位置参数。

## 目录

```text
site.json              公开公司资料、语言和站点参数
columns.json           本地栏目名称、路径、分页配置
facts.md               完整资料索引与来源（私有）
style-card.md          设计偏好与客户反馈（私有）
prd.md                 站点规划：结构、页面与内容来源（私有，新建站时写）
materials/             原始资料（私有）
content/<栏目>/*.json   采用内容工作副本（不是公开文件）
images/                公开采用图片；整体复制到 dist/images
theme/                 设计源码；结构见模板规范
  assets/              公开 CSS、JS、字体和设计图，整体复制到 dist/assets
dist/                  自动生成的唯一静态网站，不手改
.yz/                   构建记录、快照、回收站、迁移备份；不交付
```

不要把私人资料、凭证、未采用图片放 images/ 或 theme/assets/。工具拒绝源树符号链接；点文件不复制。文件须在工作空间中，不能引用本机绝对路径或 localhost。

## site.json

init 创建空字段，包括 name、brand、headline、address（按 zh-CN/en 分语言），logo、favicon、email、phone、whatsapp、wechat、locales、default_locale、domain、extra。没有信息就留空。

`extra` 放企业介绍、优势等采用事实，支持多语言对象和数组；模板用 site.extra 读取。没有域名时 sitemap 使用 example.com，仅用于本地制作；真实域名确定后填 domain 并重新生成。sample_fields 记录示例字段；正常构建不允许仍含示例。

不要设置 form.fields；表单系统字段固定，当前是本地演示。

## columns.json

```json
[
  {"key":"products","name":{"zh-CN":"产品中心","en":"Products"},"path":"products","page_size":12},
  {"key":"news","name":{"zh-CN":"新闻动态","en":"News"},"path":"news","page_size":10}
]
```

key 为小写英文开头及数字/下划线，path 为小写英文数字和短横线，page_size 为 1–1000 整数；路径不能重复。默认产品和新闻可按需求增减；案例、方案、荣誉等使用相同内容结构。分类直接填写内容 category 文本，工具生成稳定分类路径。

旧 categories/fields 配置仍可读取，便于旧模板迁移，不代表平台支持配置字段。新产品参数建议用正文表格，采用内容接平台时只映射平台既有字段。

## 内容

`new` 生成稳定 UUID，后续编辑保留 id；该 ID 是本地 ID，接平台时需建立映射。

```json
{
  "id":"由 new 命令生成",
  "slug":"gearbox",
  "visible":true,
  "sample":false,
  "featured":false,
  "date":"2026-10-16",
  "category":"传动设备",
  "cover":"images/gearbox.jpg",
  "sort":0,
  "sources":["M01 第8页"],
  "i18n":{
    "zh-CN":{"title":"来自客户的产品标题","summary":"来自客户的摘要","body":"<p>采用正文</p>","seo_title":"","seo_description":""},
    "en":{"title":"","summary":"","body":"","seo_title":"","seo_description":""}
  }
}
```

visible 仅控制下一次生成显示；sample 只用于示例预览。slug 决定 URL，避免随标题修改。分类可空，排序数字越小越前，featured 可供首页选择。缺少某语言标题时不生成该语言详情页。sources 对应 facts.md 中的资料。正文由可信的整理步骤产生，建议仅用段落、标题、列表、链接、图片和表格；工具的轻量清理不是针对任意不可信 HTML 的完整安全过滤器。

## 命令

| 命令 | 行为 |
|---|---|
| init 新目录 --name 公司名 [--locales zh-CN,en] [--style editorial] | 创建带基础模板和风格卡的站点；editorial 为编辑式风格档 |
| new 栏目 slug --title 标题 [--sample] | 创建默认显示的草稿内容 |
| check [--demo] | 检查数据、模板；完整静态资源检查在 build 执行 |
| build / preview [--demo] | 相同命令，生成 dist；失败保留原有成功产物 |
| serve [--port 8080] | 校验源文件及 dist 未变化后，只读服务 dist；仅监听 127.0.0.1 |
| show / hide 栏目/slug … [--all] | 修改草稿可见性，不自动生成 |
| delete / undelete 栏目/slug … | 删除到回收站 / 恢复为隐藏，不自动生成 |
| trash / status | 回收站 / 当前内容与产物状态 |
| export --out 工作空间外的新目录 | 复制已检查的 dist 与 manifest.json；不重建，不覆盖旧导出 |
| snapshot -m 说明 / snapshots | 保存 / 查看本地设计快照，仅 theme，连续相同设计不新增 |
| restore 编号 | 备份当前设计后恢复 theme，保留当前内容及栏目 |
| migrate | 备份并迁移旧状态字段，详见下文 |

普通 build 阻止示例内容；build --demo 允许示例并加明显标记，不能 export。导出拒绝源文件变化、dist 被手改或丢文件的情况。manifest.json 包含文件清单与 SHA-256，不带私有内容。form_mode=local-demo、platform_ready=false 表明未完成平台接入。

serve 启动后修改源文件，需要重新 build；它不会自动监听或重新生成。静态目录更新后刷新浏览器即可。表单提交仅在页面显示“未发送、未保存”，服务端拒绝 POST。

## 旧 0.4 项目迁移

在原项目目录运行 migrate。备份位置会打印：`.yz/migration-backups/<编号>/`。原 status=online 转 visible=true，offline 转 false；补本地 id，移除旧 form.fields。正文、模板、自定义字段、来源与图片保留；旧 live/、preview/、发布历史不删除、不作为新产物或本地快照使用。

旧模板如果自行依赖 preview/online/offline 状态，应按新 visible 规则修改。工具会保留旧数据但不会自动重写复杂模板。需要显示的旧内容执行 show；然后 build，检查生成结果。

publish、online、offline、refresh、releases、leads、visits、demo-data 已停用并报错，避免误认为已经操作真实平台。新工具没有后台运行服务和真实发布能力。
