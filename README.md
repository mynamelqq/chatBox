# 留白 · 多轮 AI 对话

一个由 FastAPI 同时提供页面和聊天接口的单体应用，使用 Anthropic 原生 Messages API。只需启动一个 Python 服务，API Key 始终保存在服务端。

会话和消息持久化保存在项目目录的 `data/chat.db` SQLite 数据库中。每个会话可以包含多轮消息，重启服务后仍然保留。

在新对话中首次输入文字或添加图片时，会自动建立会话。未发送的文字和图片作为草稿保存在同一数据库中；切换会话或刷新页面后重新打开该会话，会恢复草稿。

用户和助手消息下方有复制与重试图标。重试会根据该消息对应的用户提问生成一条新回答，保留原有对话内容和未发送草稿。

右侧接口设置同样持久化到 SQLite，包括接口格式、Base URL、模型、API Key 和思考强度。思考强度提供 `low`、`medium`、`high` 三档。

可以为模型与 API Key 建立多个命名分组，在右侧“调用分组”中切换。点击“管理分组 · 新建 / 导入”可打开弹窗，新建分组、直接粘贴 JSON 或选择 JSON 文件批量导入，格式为 `[{"name":"工作账号","api_key":"sk-...","model":"模型名"}]`。已有设置首次启动时会成为“默认分组”。切换分组只改变模型和 API Key，Base URL 与接口格式保持当前值；修改当前分组后点击“保存设置”即可更新它。

右侧打开“使用本地模型”后，聊天会请求本地 vLLM 的 `http://127.0.0.1:8001/v1`。可使用 `start_vllm.ps1` 启动模型服务；当前环境若提示缺少 vLLM 编译扩展或没有 CUDA，需要先安装匹配硬件的 vLLM 版本。

## 安装与配置

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

打开 `.env`，把 `ANTHROPIC_API_KEY` 替换成真实密钥。默认模型为 `claude-sonnet-4-20250514`，也可以通过 `ANTHROPIC_MODEL` 替换成你账号可用的 Anthropic 模型。

默认允许模型生成响应最长等待 180 秒。若使用代理服务响应更慢，可在 `.env` 中增大 `ANTHROPIC_READ_TIMEOUT`；连接超时和读取超时是分开配置的。

## 启动

```powershell
uvicorn server:app --reload --port 8000
```

访问 `http://localhost:8000`。页面和接口来自同一个 Python 服务，不需要 Node.js，也没有跨域配置。

Windows 上也可以双击 `start.cmd`：首次运行会创建虚拟环境并安装依赖，之后直接启动服务。需要先安装 Python 3.10 或更新版本。API Key 可在页面右侧的接口设置中填写。

## 打包

运行 `python package.py`，生成 `dist/chatBox-release.zip`。压缩包包含启动脚本、服务代码、页面和依赖清单；不会包含本机的 `.env`、`data/chat.db` 或虚拟环境。解压后运行 `start.cmd`，再访问 `http://localhost:8000`。

## 接口

- `GET /`：聊天页面
- `GET /api/health`：健康检查与当前模型
- `POST /api/chat`：接收完整的 `messages` 数组并返回助手消息
- `GET /api/sessions`：获取历史会话
- `POST /api/sessions`：创建会话
- `GET /api/sessions/{id}/messages`：获取会话消息
- `GET/PUT /api/sessions/{id}/draft`：读取或保存未发送的文字与图片
- `DELETE /api/sessions/{id}`：删除会话及其消息
