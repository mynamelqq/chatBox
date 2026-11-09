let sessions = [];
let currentSessionId = null;
let messages = [];
let isLoading = false;
let isNavigating = false;
let navigationQueue = Promise.resolve();
let errorMessage = "";
let thinkingStartedAt = 0;
let thinkingTimer = null;

const messageList = document.querySelector("#messages");
const conversation = document.querySelector("#conversation");
const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const imageInput = document.querySelector("#image-input");
const uploadImageButton = document.querySelector("#upload-image-button");
const imagePreviews = document.querySelector("#image-previews");
const resetButton = document.querySelector("#reset-button");
const sessionList = document.querySelector("#session-list");
const sessionCount = document.querySelector("#session-count");
const currentTitle = document.querySelector("#current-title");
const emptyState = document.querySelector("#empty-state");
const providerFormat = document.querySelector("#provider-format");
const baseUrl = document.querySelector("#base-url");
const modelName = document.querySelector("#model-name");
const apiKey = document.querySelector("#api-key");
const profileSelect = document.querySelector("#profile-select");
const manageProfilesButton = document.querySelector("#manage-profiles");
const profilesDialog = document.querySelector("#profiles-dialog");
const closeProfilesButton = document.querySelector("#close-profiles");
const profileForm = document.querySelector("#profile-form");
const profileName = document.querySelector("#profile-name");
const profileModel = document.querySelector("#profile-model");
const profileKey = document.querySelector("#profile-key");
const profileStatus = document.querySelector("#profile-status");
const importProfilesButton = document.querySelector("#import-profiles");
const importPastedProfilesButton = document.querySelector("#import-pasted-profiles");
const profileJson = document.querySelector("#profile-json");
const deleteProfileButton = document.querySelector("#delete-profile");
const profileFile = document.querySelector("#profile-file");
const thinkingLevel = document.querySelector("#thinking-level");
const thinkingValue = document.querySelector("#thinking-value");
const saveSettings = document.querySelector("#save-settings");
const settingsStatus = document.querySelector("#settings-status");
const localEnabled = document.querySelector("#local-enabled");
const localModelPath = document.querySelector("#local-model-path");
const jumpList = document.querySelector("#jump-list");
const jumpCount = document.querySelector("#jump-count");
let activeUserMessageIndex = -1;
let pendingImages = [];
let creatingSession = null;
let draftTimer = null;
let draftSaving = Promise.resolve();
let draftVersion = 0;
let savedDraftVersion = 0;
let pendingImageReads = Promise.resolve();
let scrollConversationToTop = false;
let followConversationBottom = true;
let resumeFollowOnUserScroll = false;
let lastAutoScrollTop = null;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_IMAGES = 4;

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "请求失败，请稍后重试。");
  return data;
}

async function loadSettings() {
  const settings = await request("/api/settings");
  applySettings(settings);
  await loadProfiles(settings.active_profile_id);
}

function applySettings(settings) {
  providerFormat.value = settings.provider_format;
  localEnabled.checked = settings.local_enabled;
  localModelPath.value = settings.local_model_path;
  updateLocalMode();
  baseUrl.value = settings.base_url;
  modelName.value = settings.model;
  selectThinkingLevel(settings.thinking_level);
  apiKey.value = "";
  apiKey.placeholder = `当前 Key：${settings.api_key_masked}；留空则保持`;
}

async function loadProfiles(selectedId) {
  const profiles = await request("/api/profiles");
  profileSelect.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.name} · ${profile.model} · ${profile.api_key_masked}`;
    profileSelect.append(option);
  }
  profileSelect.value = selectedId || profiles.find((profile) => profile.active)?.id || "default";
  deleteProfileButton.disabled = profileSelect.value === "default";
}

async function activateProfile(id) {
  const settings = await request(`/api/profiles/${encodeURIComponent(id)}/activate`, { method: "PUT" });
  applySettings(settings);
  await loadProfiles(id);
  settingsStatus.textContent = "已切换调用分组";
}

async function addProfile() {
  const name = profileName.value.trim();
  const key = profileKey.value.trim();
  const model = profileModel.value.trim();
  if (!name || !key || !model) throw new Error("请填写分组名称、模型和新的 API Key。");
  const profile = await request("/api/profiles", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, api_key: key, model }),
  });
  await activateProfile(profile.id);
  profileForm.reset();
  profilesDialog.close();
}

async function importProfiles(jsonText) {
  const parsed = JSON.parse(jsonText);
  const items = Array.isArray(parsed) ? parsed : parsed.profiles;
  if (!Array.isArray(items) || !items.length || items.some((item) =>
    !item || typeof item.name !== "string" || typeof item.api_key !== "string" || typeof item.model !== "string" ||
    !item.name.trim() || !item.api_key.trim() || !item.model.trim())) {
    throw new Error("JSON 应为包含 name、api_key、model 的非空数组。");
  }
  for (const item of items) {
    await request("/api/profiles", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: item.name, api_key: item.api_key, model: item.model }),
    });
  }
  await loadProfiles(profileSelect.value);
  profileStatus.textContent = `已导入 ${items.length} 个分组`;
  profileJson.value = "";
}

async function saveRuntimeSettings() {
  saveSettings.disabled = true;
  settingsStatus.textContent = "保存中…";
  try {
    const settings = await request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_format: providerFormat.value,
        local_enabled: localEnabled.checked,
        local_model_path: localModelPath.value.trim(),
        base_url: baseUrl.value.trim(),
        model: modelName.value.trim(),
        api_key: apiKey.value,
        thinking_level: thinkingValue.value,
      }),
    });
    apiKey.value = "";
    apiKey.placeholder = `当前 Key：${settings.api_key_masked}；留空则保持`;
    await loadProfiles(settings.active_profile_id);
    settingsStatus.textContent = `已保存 · ${settings.api_key_masked}`;
    setTimeout(() => { settingsStatus.textContent = ""; }, 3500);
  } catch (error) {
    settingsStatus.textContent = error instanceof Error ? error.message : "保存失败";
  } finally {
    saveSettings.disabled = false;
  }
}

function updateLocalMode() {
  document.querySelectorAll(".local-only").forEach((element) => { element.disabled = !localEnabled.checked; });
  providerFormat.disabled = localEnabled.checked;
  baseUrl.disabled = localEnabled.checked;
  modelName.disabled = localEnabled.checked;
  apiKey.disabled = localEnabled.checked;
}

const messageIcons = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.3-5.7"/><path d="M20 4v6h-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
};

function createMessage(message, streaming = false) {
  const article = document.createElement("article");
  article.className = `message message-${message.role}${streaming ? " is-streaming" : ""}`;
  article.messageData = message;
  article.dataset.rawContent = message.content;
  const role = document.createElement("p");
  role.className = "message-role";
  role.textContent = message.role === "user" ? "你" : "AI";
  const content = document.createElement("div");
  content.className = "message-content";
  if (message.role === "assistant") {
    content.innerHTML = markdownToHtml(message.content);
    article.dataset.renderedContent = message.content;
  }
  else content.textContent = message.content;
  if (message.images?.length) {
    const images = document.createElement("div");
    images.className = "message-images";
    message.images.forEach((image) => {
      const picture = document.createElement("img");
      picture.src = `data:${image.media_type};base64,${image.data}`;
      picture.alt = image.name || "上传的图片";
      picture.loading = "lazy";
      images.append(picture);
    });
    content.append(images);
  }
  article.append(role, content);
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.innerHTML = messageIcons.copy;
  copy.title = "复制消息";
  copy.setAttribute("aria-label", "复制消息");
  copy.onclick = () => { void copyMessage(article.messageData, copy); };
  const retry = document.createElement("button");
  retry.type = "button";
  retry.innerHTML = messageIcons.retry;
  retry.title = "重试此提问";
  retry.setAttribute("aria-label", "重试此提问");
  retry.disabled = !message.id || isLoading;
  retry.onclick = () => { void retryMessage(article.messageData.id); };
  actions.append(copy, retry);
  article.append(actions);
  return article;
}

async function copyMessage(message, button) {
  try {
    if (message.content) {
      await navigator.clipboard.writeText(message.content);
    } else if (message.images?.length && navigator.clipboard.write && window.ClipboardItem) {
      const image = message.images[0];
      const raw = atob(image.data);
      const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ [image.media_type]: new Blob([bytes], { type: image.media_type }) })]);
    } else {
      throw new Error("没有可复制的文本");
    }
    button.innerHTML = messageIcons.check;
    button.title = "已复制";
    button.setAttribute("aria-label", "已复制");
  } catch {
    button.title = "复制失败";
    button.setAttribute("aria-label", "复制失败");
  }
  window.setTimeout(() => {
    button.innerHTML = messageIcons.copy;
    button.title = "复制消息";
    button.setAttribute("aria-label", "复制消息");
  }, 1800);
}

function markdownToHtml(markdown) {
  const escaped = markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  const blocks = escaped.split(/```/g);
  return blocks.map((block, index) => {
    if (index % 2 === 1) return `<pre><code>${block.replace(/^\w+\n/, "")}</code></pre>`;
    const lines = block.split("\n");
    const parts = [];
    let proseStart = 0;
    for (let lineIndex = 0; lineIndex + 1 < lines.length; lineIndex++) {
      const header = splitTableRow(lines[lineIndex]);
      const separators = splitTableRow(lines[lineIndex + 1]);
      if (!header || !separators || header.length !== separators.length ||
          !separators.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) continue;

      parts.push(renderProse(lines.slice(proseStart, lineIndex).join("\n").trim()));
      const alignments = separators.map((cell) => {
        const marker = cell.trim();
        return marker.startsWith(":") && marker.endsWith(":") ? "center" : marker.endsWith(":") ? "right" : "left";
      });
      const tableRow = (cells, tag) => `<tr>${alignments.map((alignment, column) =>
        `<${tag} class="align-${alignment}">${renderInline(cells[column] || "")}</${tag}>`).join("")}</tr>`;
      let table = `<div class="table-scroll"><table><thead>${tableRow(header, "th")}</thead><tbody>`;
      lineIndex++;
      while (lineIndex + 1 < lines.length && lines[lineIndex + 1].trim() && lines[lineIndex + 1].includes("|")) {
        table += tableRow(splitTableRow(lines[++lineIndex]) || [], "td");
      }
      parts.push(`${table}</tbody></table></div>`);
      proseStart = lineIndex + 1;
    }
    parts.push(renderProse(lines.slice(proseStart).join("\n").trim()));
    return parts.join("");
  }).join("");
}

function splitTableRow(line) {
  if (!line.includes("|")) return null;
  let source = line.trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);
  const cells = [];
  let cell = "";
  let codeTicks = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (character === "`") {
      let end = index;
      while (source[end] === "`") end++;
      const count = end - index;
      if (!codeTicks || codeTicks === count) codeTicks = codeTicks ? 0 : count;
      cell += source.slice(index, end);
      index = end - 1;
    } else if (character === "|" && !codeTicks) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function renderInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderProse(block) {
  if (!block) return "";
  const output = [];
  const lists = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    const list = lists.pop();
    output.push(`</li></${list.type}>`);
  };
  for (const line of block.split("\n")) {
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      const indent = listMatch[1].replace(/\t/g, "    ").length;
      const type = /^\d/.test(listMatch[2]) ? "ol" : "ul";
      while (lists.length && indent < lists.at(-1).indent) closeList();
      if (lists.length && indent === lists.at(-1).indent && type !== lists.at(-1).type) closeList();
      if (!lists.length || indent > lists.at(-1).indent) {
        output.push(`<${type}><li>${renderInline(listMatch[3])}`);
        lists.push({ indent, type });
      } else {
        output.push(`</li><li>${renderInline(listMatch[3])}`);
      }
      continue;
    }
    if (lists.length && /^\s+/.test(line)) {
      output.push(` ${renderInline(line.trim())}`);
      continue;
    }
    while (lists.length) closeList();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      output.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  while (lists.length) closeList();
  return output.join("");
}

async function streamChat(content, images, onText, retryOfMessageId = null) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: currentSessionId, content, images, retry_of_message_id: retryOfMessageId }),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.detail || "请求失败，请稍后重试。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const data = JSON.parse(dataLine.slice(5).trim() || "{}");
      if (event.startsWith("event: error")) throw new Error(data.detail || "流式请求失败");
      if (event.startsWith("event: done")) completed = true;
      if (data.text) onText(data.text);
    }
    if (done) break;
  }
  if (!completed) throw new Error("流式响应意外结束。");
}

function createThinking() {
  const article = document.createElement("article");
  article.className = "message message-assistant message-thinking";
  const elapsed = thinkingStartedAt ? Math.max(0, Math.round((Date.now() - thinkingStartedAt) / 1000)) : 0;
  article.innerHTML = `
    <p class="message-role">AI</p>
    <details class="thinking-details" open>
      <summary><span class="thinking"><span></span><span></span><span></span></span><span class="thinking-elapsed">正在思考 · ${elapsed}s</span></summary>
      <p class="thinking-note">模型正在生成回答，中间推理不会直接展示。</p>
    </details>
  `;
  return article;
}

function appendError(text) {
  const box = document.createElement("div");
  box.className = "error";
  box.setAttribute("role", "alert");
  const message = document.createElement("span");
  message.textContent = text;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  close.onclick = () => { errorMessage = ""; render(); };
  box.append(message, close);
  messageList.append(box);
}

function render(preserveExisting = false) {
  const previousScrollTop = conversation.scrollTop;
  if (isLoading && followConversationBottom && lastAutoScrollTop !== null &&
      previousScrollTop < lastAutoScrollTop - 4) {
    followConversationBottom = false;
    resumeFollowOnUserScroll = false;
  }
  const existing = preserveExisting ? [...messageList.children] : [];
  const elements = messages.map((message, index) => {
    const previous = existing[index];
    const reusable = previous && previous.classList.contains(`message-${message.role}`) &&
      (!previous.classList.contains("is-streaming") || !isLoading) &&
      !previous.classList.contains("message-thinking") &&
      previous.dataset.rawContent === message.content;
    const element = reusable ? previous :
      isLoading && index === messages.length - 1 && message.role === "assistant" && !message.content
        ? createThinking() : createMessage(message);
    if (reusable) {
      element.messageData = message;
      if (!isLoading && element.classList.contains("is-streaming")) {
        element.classList.remove("is-streaming");
        updateStreamMarkdown(element);
      }
      const retry = element.querySelector(".message-actions button:last-child");
      if (retry) retry.disabled = !message.id || isLoading;
    }
    element.dataset.messageIndex = index;
    if (message.role === "user") element.id = `user-message-${index}`;
    return element;
  });
  if (preserveExisting) {
    elements.forEach((element, index) => {
      if (messageList.children[index] !== element) messageList.insertBefore(element, messageList.children[index] || null);
    });
    while (messageList.children.length > elements.length) messageList.lastElementChild.remove();
  } else {
    messageList.replaceChildren(...elements);
  }
  emptyState.hidden = messages.length > 0 || Boolean(errorMessage) || isLoading;
  if (isLoading && !messages.length) messageList.append(createThinking());
  if (errorMessage) appendError(errorMessage);
  renderJumpList();
  if (scrollConversationToTop) {
    conversation.scrollTop = 0;
    lastAutoScrollTop = null;
  } else if (followConversationBottom) {
    conversation.scrollTop = conversation.scrollHeight;
    lastAutoScrollTop = conversation.scrollTop;
  } else {
    conversation.scrollTop = previousScrollTop;
  }
  scrollConversationToTop = false;
}

function selectionWithin(element) {
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed &&
    (element.contains(selection.anchorNode) || element.contains(selection.focusNode)));
}

function updateStreamMarkdown(article) {
  const content = article.querySelector(".message-content");
  const markdown = article.messageData?.content;
  if (!content || markdown === article.dataset.renderedContent) return;
  if (selectionWithin(content)) {
    article.dataset.pendingMarkdown = "true";
    return;
  }
  content.innerHTML = markdownToHtml(markdown);
  article.dataset.renderedContent = markdown;
  delete article.dataset.pendingMarkdown;
}

document.addEventListener("selectionchange", () => {
  messageList.querySelectorAll('[data-pending-markdown="true"]').forEach(updateStreamMarkdown);
});

function appendStreamText(message, text) {
  if (followConversationBottom && lastAutoScrollTop !== null && conversation.scrollTop < lastAutoScrollTop - 4) {
    followConversationBottom = false;
    resumeFollowOnUserScroll = false;
  }
  const index = messages.length - 1;
  let article = messageList.querySelector(`[data-message-index="${index}"]`);
  if (!article || article.classList.contains("message-thinking")) {
    const replacement = createMessage(message, true);
    replacement.dataset.messageIndex = index;
    if (article) article.replaceWith(replacement);
    else messageList.append(replacement);
    article = replacement;
  }
  message.content += text;
  article.dataset.rawContent = message.content;
  updateStreamMarkdown(article);
  if (followConversationBottom) {
    conversation.scrollTop = conversation.scrollHeight;
    lastAutoScrollTop = conversation.scrollTop;
  }
}

function renderJumpList() {
  const userMessages = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === "user");
  jumpCount.textContent = String(userMessages.length);
  jumpList.replaceChildren(...userMessages.map(({ message, index }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `jump-item${index === activeUserMessageIndex ? " active" : ""}`;
    const label = message.content.replace(/\s+/g, " ").trim() || `图片${message.images?.length ? ` · ${message.images.length} 张` : ""}`;
    button.textContent = label;
    button.title = label;
    button.onclick = () => {
      activeUserMessageIndex = index;
      followConversationBottom = false;
      document.querySelector(`#user-message-${index}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      renderJumpList();
    };
    return button;
  }));
}

conversation.addEventListener("scroll", () => {
  if (resumeFollowOnUserScroll && conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop <= 2) {
    followConversationBottom = true;
    resumeFollowOnUserScroll = false;
  }
  const userElements = [...messageList.querySelectorAll(".message-user")];
  if (!userElements.length) return;
  const midpoint = conversation.getBoundingClientRect().top + conversation.clientHeight * 0.35;
  const closest = userElements.reduce((best, current) => {
    const distance = Math.abs(current.getBoundingClientRect().top - midpoint);
    return distance < best.distance ? { element: current, distance } : best;
  }, { element: userElements[0], distance: Infinity });
  const nextIndex = Number(closest.element.dataset.messageIndex);
  if (nextIndex !== activeUserMessageIndex) {
    activeUserMessageIndex = nextIndex;
    renderJumpList();
  }
});

conversation.addEventListener("wheel", (event) => {
  if (event.deltaY < 0) {
    followConversationBottom = false;
    resumeFollowOnUserScroll = false;
  } else if (event.deltaY > 0 && !followConversationBottom) {
    resumeFollowOnUserScroll = true;
    if (conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop <= 2) {
      followConversationBottom = true;
      resumeFollowOnUserScroll = false;
    }
  }
}, { passive: true });

function startThinkingTimer() {
  thinkingStartedAt = Date.now();
  window.clearInterval(thinkingTimer);
  thinkingTimer = window.setInterval(() => {
    if (!isLoading) {
      window.clearInterval(thinkingTimer);
      return;
    }
    const elapsed = messageList.querySelector(".message-thinking .thinking-elapsed");
    if (elapsed) elapsed.textContent = `正在思考 · ${Math.max(0, Math.round((Date.now() - thinkingStartedAt) / 1000))}s`;
  }, 1000);
}

function renderSessions() {
  sessionCount.textContent = String(sessions.length);
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "session-empty";
    empty.textContent = "还没有历史对话";
    sessionList.replaceChildren(empty);
    return;
  }
  sessionList.replaceChildren(...sessions.map((session) => {
    const item = document.createElement("div");
    item.className = `session-item${session.id === currentSessionId ? " active" : ""}`;
    const button = document.createElement("button");
    button.className = "session-open";
    button.type = "button";
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title;
    const meta = document.createElement("small");
    meta.className = "session-meta";
    meta.textContent = `${session.message_count || 0} 条消息 · ${formatDate(session.updated_at)}`;
    button.append(title, meta);
    button.onclick = () => openSession(session.id);
    const edit = document.createElement("button");
    edit.className = "session-action session-edit";
    edit.type = "button";
    edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z"/></svg>';
    edit.title = "编辑标题";
    edit.setAttribute("aria-label", `编辑${session.title}的标题`);
    edit.onclick = () => startSessionRename(item, session);
    const remove = document.createElement("button");
    remove.className = "session-action session-delete";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `删除${session.title}`);
    remove.onclick = (event) => { event.stopPropagation(); deleteSession(session.id); };
    item.append(button, edit, remove);
    return item;
  }));
}

function startSessionRename(item, session) {
  const field = document.createElement("input");
  field.className = "session-rename";
  field.type = "text";
  field.maxLength = 80;
  field.value = session.title;
  field.setAttribute("aria-label", "会话标题");
  let finished = false;
  const save = async () => {
    if (finished) return;
    finished = true;
    const title = field.value.trim();
    if (!title || title === session.title) { renderSessions(); return; }
    try {
      const updated = await request(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      session.title = updated.title;
      if (session.id === currentSessionId) currentTitle.textContent = updated.title;
      renderSessions();
    } catch (error) {
      finished = false;
      field.setCustomValidity(error instanceof Error ? error.message : "保存标题失败");
      field.reportValidity();
      field.focus();
    }
  };
  field.oninput = () => field.setCustomValidity("");
  field.onkeydown = (event) => {
    if (event.key === "Enter") { event.preventDefault(); field.blur(); }
    if (event.key === "Escape") { finished = true; renderSessions(); }
  };
  field.onblur = () => { void save(); };
  item.replaceChildren(field);
  field.focus();
  field.select();
}

async function loadSessions() {
  sessions = await request("/api/sessions");
  if (sessions.length) await openSession(sessions[0].id);
  else await resetToHome();
  renderSessions();
}

async function createSession() {
  const session = await request("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "新对话" }) });
  sessions = [session, ...sessions.filter((item) => item.id !== session.id)];
  currentSessionId = session.id;
  currentTitle.textContent = session.title;
  messages = [];
  activeUserMessageIndex = -1;
  errorMessage = "";
  followConversationBottom = true;
  lastAutoScrollTop = null;
  renderSessions();
  render();
}

function ensureSession() {
  if (currentSessionId) return Promise.resolve(currentSessionId);
  if (!creatingSession) {
    creatingSession = createSession().then(() => currentSessionId).finally(() => { creatingSession = null; });
  }
  return creatingSession;
}

function saveDraft() {
  if (draftVersion === savedDraftVersion) return draftSaving;
  const content = input.value;
  const images = [...pendingImages];
  const version = draftVersion;
  if (!currentSessionId && !creatingSession && !content && !images.length) return draftSaving;
  const targetSession = currentSessionId ? Promise.resolve(currentSessionId) : ensureSession();
  draftSaving = draftSaving.catch(() => {}).then(async () => {
    const sessionId = await targetSession;
    await request(`/api/sessions/${sessionId}/draft`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, images }),
    });
    savedDraftVersion = Math.max(savedDraftVersion, version);
    try {
      sessions = await request("/api/sessions");
      if (currentSessionId === sessionId) {
        currentTitle.textContent = sessions.find((session) => session.id === sessionId)?.title || currentTitle.textContent;
      }
      renderSessions();
    } catch {
      // The draft is saved; the history list can refresh on the next successful request.
    }
  });
  return draftSaving;
}

function scheduleDraftSave() {
  if (!currentSessionId && !creatingSession && !input.value && !pendingImages.length) return;
  draftVersion++;
  void ensureSession().catch((error) => { errorMessage = error.message; render(); });
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    void saveDraft().catch((error) => { errorMessage = error.message; render(); });
  }, 350);
}

async function flushDraft() {
  await pendingImageReads;
  window.clearTimeout(draftTimer);
  if (draftVersion !== savedDraftVersion) await saveDraft();
  else await draftSaving;
}

async function openSession(sessionId) {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session || isLoading) return;
  const navigation = navigationQueue.catch(() => {}).then(async () => {
    isNavigating = true;
    input.disabled = true;
    try {
      await flushDraft();
      currentSessionId = sessionId;
      currentTitle.textContent = session.title;
      const [stored, draft] = await Promise.all([
        request(`/api/sessions/${sessionId}/messages`),
        request(`/api/sessions/${sessionId}/draft`),
      ]);
      messages = stored;
      input.value = draft.content;
      pendingImages = draft.images;
      draftVersion = 0;
      savedDraftVersion = 0;
      renderImagePreviews();
      resizeInput();
      activeUserMessageIndex = messages.findIndex((message) => message.role === "user");
      errorMessage = "";
      followConversationBottom = true;
      lastAutoScrollTop = null;
      renderSessions();
      render();
    } finally {
      isNavigating = false;
      input.disabled = false;
      resizeInput();
    }
  });
  navigationQueue = navigation;
  return navigation;
}

async function deleteSession(sessionId) {
  if (isLoading || isNavigating) return;
  const session = sessions.find((item) => item.id === sessionId);
  if (session && !window.confirm(`确定删除“${session.title}”吗？其中的消息也会被删除。`)) return;
  const wasCurrent = sessionId === currentSessionId;
  if (wasCurrent) await flushDraft();
  await request(`/api/sessions/${sessionId}`, { method: "DELETE" });
  sessions = sessions.filter((session) => session.id !== sessionId);
  if (wasCurrent) {
    currentSessionId = null;
    input.value = "";
    pendingImages = [];
    renderImagePreviews();
    resizeInput();
  }
  if (!sessions.length) await resetToHome();
  else if (wasCurrent) await openSession(sessions[0].id);
  renderSessions();
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  sendButton.disabled = (!input.value.trim() && !pendingImages.length) || isLoading;
}

function renderImagePreviews() {
  imagePreviews.replaceChildren(...pendingImages.map((image, index) => {
    const item = document.createElement("div");
    item.className = "image-preview";
    const preview = document.createElement("img");
    preview.src = `data:${image.media_type};base64,${image.data}`;
    preview.alt = image.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `移除 ${image.name}`);
    remove.onclick = () => {
      pendingImages.splice(index, 1);
      renderImagePreviews();
      resizeInput();
      scheduleDraftSave();
    };
    item.append(preview, remove);
    return item;
  }));
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve({ media_type: file.type, data: result.slice(result.indexOf(",") + 1), name: file.name || "图片" });
    };
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function addImages(files) {
  const selected = [...files];
  if (!selected.length) return;
  const available = MAX_IMAGES - pendingImages.length;
  if (available <= 0) {
    errorMessage = `每条消息最多上传 ${MAX_IMAGES} 张图片。`;
    render();
    return;
  }
  const accepted = selected.slice(0, available);
  const invalid = accepted.find((file) => !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type) || file.size > MAX_IMAGE_SIZE);
  if (invalid) {
    errorMessage = "仅支持 JPEG、PNG、GIF、WebP 格式，且单张图片不能超过 5MB。";
    render();
    return;
  }
  try {
    const readTask = Promise.all(accepted.map(readImage));
    pendingImageReads = Promise.allSettled([pendingImageReads, readTask]).then(() => {});
    pendingImages.push(...await readTask);
    errorMessage = selected.length > available ? `最多只能上传 ${MAX_IMAGES} 张图片。` : "";
    renderImagePreviews();
    resizeInput();
    scheduleDraftSave();
    if (errorMessage) render();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "图片读取失败。";
    render();
  }
}

async function sendMessage(event) {
  event?.preventDefault();
  const content = input.value.trim();
  const images = pendingImages;
  if ((!content && !images.length) || isLoading || isNavigating) return;
  isLoading = true;
  input.disabled = true;
  sendButton.disabled = true;
  try {
    await flushDraft();
  } catch (error) {
    isLoading = false;
    input.disabled = false;
    resizeInput();
    errorMessage = error instanceof Error ? error.message : "草稿保存失败。";
    render();
    return;
  }
  messages.push({ role: "user", content, images });
  followConversationBottom = true;
  lastAutoScrollTop = null;
  input.value = "";
  pendingImages = [];
  renderImagePreviews();
  errorMessage = "";
  startThinkingTimer();
  input.disabled = true;
  resetButton.disabled = true;
  resizeInput();
  render(true);
  try {
    messages.push({ role: "assistant", content: "" });
    render(true);
    await streamChat(content, images, (text) => {
      appendStreamText(messages[messages.length - 1], text);
    });
    messages = await request(`/api/sessions/${currentSessionId}/messages`);
    const updated = await request("/api/sessions");
    sessions = updated;
    currentTitle.textContent = sessions.find((session) => session.id === currentSessionId)?.title || currentTitle.textContent;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "暂时无法连接服务。";
    try {
      const [stored, draft, updated] = await Promise.all([
        request(`/api/sessions/${currentSessionId}/messages`),
        request(`/api/sessions/${currentSessionId}/draft`),
        request("/api/sessions"),
      ]);
      messages = stored;
      sessions = updated;
      input.value = draft.content;
      pendingImages = draft.images;
      renderImagePreviews();
    } catch {
      // Keep the current view if the local service is temporarily unavailable.
    }
  } finally {
    isLoading = false;
    window.clearInterval(thinkingTimer);
    input.disabled = false;
    resetButton.disabled = false;
    resizeInput();
    renderSessions();
    render(true);
    input.focus({ preventScroll: true });
  }
}

async function retryMessage(messageId) {
  if (!messageId || isLoading || isNavigating) return;
  isLoading = true;
  input.disabled = true;
  resetButton.disabled = true;
  try {
    await flushDraft();
    errorMessage = "";
    messages.push({ role: "assistant", content: "" });
    startThinkingTimer();
    resizeInput();
    render(true);
    await streamChat("", [], (text) => {
      appendStreamText(messages[messages.length - 1], text);
    }, messageId);
    messages = await request(`/api/sessions/${currentSessionId}/messages`);
    sessions = await request("/api/sessions");
  } catch (error) {
    if (messages.at(-1)?.role === "assistant" && !messages.at(-1)?.id) messages.pop();
    errorMessage = error instanceof Error ? error.message : "重试失败。";
  } finally {
    isLoading = false;
    window.clearInterval(thinkingTimer);
    input.disabled = false;
    resetButton.disabled = false;
    resizeInput();
    renderSessions();
    render(true);
  }
}

form.addEventListener("submit", sendMessage);
input.addEventListener("input", () => { resizeInput(); scheduleDraftSave(); });
input.addEventListener("paste", (event) => { void pasteImages(event); });
input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } });
uploadImageButton.onclick = () => imageInput.click();
imageInput.onchange = () => { void addImages(imageInput.files); imageInput.value = ""; };
async function pasteImages(event) {
  const clipboard = event.clipboardData;
  const itemImages = [...(clipboard?.items || [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file) => file?.type.startsWith("image/"));
  const fileImages = [...(clipboard?.files || [])].filter((file) => file.type.startsWith("image/"));
  const images = itemImages.length ? itemImages : fileImages;
  if (images.length) {
    event.preventDefault();
    await addImages(images);
    return;
  }

  const types = [...(clipboard?.types || [])];
  if (types.includes("text/plain") && !types.includes("Files")) return;
  if (!navigator.clipboard?.read) return;
  try {
    const entries = await navigator.clipboard.read();
    const clipboardImages = [];
    for (const entry of entries) {
      for (const type of entry.types.filter((value) => value.startsWith("image/"))) {
        const blob = await entry.getType(type);
        clipboardImages.push(new File([blob], `粘贴图片.${type.split("/")[1]}`, { type }));
      }
    }
    if (clipboardImages.length) await addImages(clipboardImages);
  } catch {
    // The browser may deny Clipboard API reads; the regular paste remains available.
  }
}
async function resetToHome() {
  const navigation = navigationQueue.catch(() => {}).then(async () => {
  isNavigating = true;
  input.disabled = true;
  try {
    await flushDraft();
    currentSessionId = null;
    currentTitle.textContent = "新对话";
    messages = [];
    input.value = "";
    pendingImages = [];
    draftVersion = 0;
    savedDraftVersion = 0;
    scrollConversationToTop = true;
    followConversationBottom = false;
    renderImagePreviews();
    activeUserMessageIndex = -1;
    errorMessage = "";
    renderSessions();
    render();
  } finally {
    isNavigating = false;
    input.disabled = false;
    resizeInput();
    input.focus();
  }
  });
  navigationQueue = navigation;
  return navigation;
}

resetButton.onclick = () => { if (!isLoading) void resetToHome().catch((error) => { errorMessage = error.message; render(); }); };
function selectThinkingLevel(level) {
  const value = ["low", "medium", "high"].includes(level) ? level : "medium";
  thinkingValue.value = value;
  thinkingLevel.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("selected", button.dataset.level === value);
  });
}

thinkingLevel.querySelectorAll("button").forEach((button) => {
  button.onclick = () => selectThinkingLevel(button.dataset.level);
});
saveSettings.onclick = () => { void saveRuntimeSettings(); };
async function profileAction(action) {
  try { await action(); }
  catch (error) {
    const status = profilesDialog.open ? profileStatus : settingsStatus;
    status.textContent = error instanceof Error ? error.message : "分组操作失败";
    const settings = await request("/api/settings");
    await loadProfiles(settings.active_profile_id);
  }
}
profileSelect.onchange = () => { void profileAction(() => activateProfile(profileSelect.value)); };
manageProfilesButton.onclick = () => {
  profileStatus.textContent = "";
  profileModel.value = modelName.value;
  profileKey.value = "";
  profilesDialog.showModal();
  profileName.focus();
};
closeProfilesButton.onclick = () => profilesDialog.close();
profilesDialog.addEventListener("cancel", (event) => {
  // Keep editing and IME shortcuts from dismissing the native dialog.
  event.preventDefault();
});
profileForm.onsubmit = (event) => { event.preventDefault(); void profileAction(addProfile); };
importPastedProfilesButton.onclick = () => { void profileAction(() => importProfiles(profileJson.value)); };
importProfilesButton.onclick = () => profileFile.click();
profileFile.onchange = () => {
  const file = profileFile.files?.[0];
  if (file) void profileAction(async () => importProfiles(await file.text()));
  profileFile.value = "";
};
deleteProfileButton.onclick = () => { void profileAction(async () => {
  await request(`/api/profiles/${encodeURIComponent(profileSelect.value)}`, { method: "DELETE" });
  await loadSettings();
  profileStatus.textContent = "已删除分组，已切换到默认分组";
}); };
localEnabled.onchange = updateLocalMode;

function formatDate(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

void Promise.all([loadSettings(), loadSessions()]).catch((error) => { errorMessage = error.message; render(); });
