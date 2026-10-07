# 示例配置

默认缺少 `config/business-profile.json` 时读取 `config/business-profile.example.json`；示例关闭定时任务并启用模板模式。Vitest 用 `tests/fixtures/` 的专用配置，只配合测试替代网关。

接真实企业应用时：

1. 复制 `.env.example` 为 `.env`，填自己的应用授权、表格资源与用户允许名单。
2. 复制 `config/business-profile.example.json` 为 `config/business-profile.json`，配置实际表名、时区、店铺别名与自己的商品映射。
3. 参考 `tenant-registry.example.json` 分别配置每个租户和群聊路由；不要将示例店铺名字视为已接入账号。
4. 通过 `TIKTOK_PIPELINE_ROOT` 指向相邻的 `tiktok-shop-data-pipeline`；必要时通过 `TIKTOK_PIPELINE_PYTHON` 指定其 Python。
5. 先核对只读查询和更新预演，再使用需要写入的命令。历史运营与迁移脚本中的 `demo_` 标识需要按自己的表结构替换。

`.env`、实际业务配置、联系人、备份和运行记录都保存在本机。这里没有替你授权或接入企业应用。
