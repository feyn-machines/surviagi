# openaiwill 本体 v2.1.0

本地本体草案；结构版本不表示语义已穷尽或已生产发布。

## 阅读顺序

1. [schema.json](schema.json)：唯一的类型定义。14 个类（其中 5 个概念类）、79 个属性、24 个关系、37 个词表、29 条约束。
2. [ontology.ttl](ontology.ttl)：同一份 schema 的标准格式导出（RDFS/OWL、SKOS、SHACL）。
3. [data-format.json](data-format.json)：封存数据文件每一行的格式，由 schema 生成。
4. [赛道目录](market-catalog.md)与[职业及全部任务目录](occupation-catalog.md)。

概念在 concepts.jsonl，层级关系在 relations.jsonl，外部映射在 external_mappings.jsonl；闸门在 gates.json，公司名单在 organizations.json；reference_* 是来源系统的参考数据。人物、账号、帖子、更新、模型、供应商的实例在数据库里，不在本包。

本包继承 v2.0.0 的全部数据文件，逐字节相同，所有 ID 不变。manifest.json 记录来源版本的根哈希和每个文件的哈希；manifest.sha256 用于完整性检查，不是身份签名。

O*NET 来源采用 CC BY 4.0；中文职业译名和编辑目录为改编/自有草案。ISIC 仅含代码和层级。详情见 sources.jsonl。
