/*
 * Obsidian WeChat Publisher
 * 开发制作: 铭泽律师 (Maxwell)
 * 插件描述: 专为法律人与创作者设计的本地微信公众号草稿箱一键渲染与同步工具。
 * 开源许可: MIT License (完全免费，支持自由分发与修改，请保留作者署名)。
 */
const { Plugin, PluginSettingTab, Setting, Notice, MarkdownRenderer, Component, ItemView } = require('obsidian');
const fs = require('fs');
const path = require('path');
const https = require('https');

const WECHAT_PREVIEW_VIEW_TYPE = 'wechat-preview-view';

const DEFAULT_SETTINGS = {
  appId: '',
  appSecret: '',
  author: '铭泽律师',
  layoutMode: 'minimalist',
  primaryColor: '#d4af37',
  fontFamily: 'sans-serif'
};

class WeChatPublisherPlugin extends Plugin {
  async onload() {
    console.log('Loading WeChat Publisher Free Plugin');
    await this.loadSettings();

    // Register Custom side-by-side View
    this.registerView(
      WECHAT_PREVIEW_VIEW_TYPE,
      (leaf) => new WeChatPreviewView(leaf, this)
    );

    // Command 1: Direct publish
    this.addCommand({
      id: 'publish-active-note-to-wechat',
      name: '同步当前笔记到微信公众号草稿箱',
      callback: () => this.publishActiveNote(false)
    });

    // Command 2: Side-by-side Preview
    this.addCommand({
      id: 'preview-wechat-layout',
      name: '预览当前笔记的微信排版效果',
      callback: () => this.publishActiveNote(true)
    });

    // Add settings tab
    this.addSettingTab(new WeChatPublisherSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  preprocessEmbeds(tempEl) {
    tempEl.querySelectorAll('span.internal-embed').forEach(span => {
      const src = span.getAttribute('src');
      if (!src) return;
      
      const ext = path.extname(src).toLowerCase();
      const isImg = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(ext);
      
      if (isImg) {
        const img = document.createElement('img');
        img.setAttribute('src', src);
        
        const alt = span.getAttribute('alt') || '';
        img.setAttribute('alt', alt);
        
        span.parentNode.replaceChild(img, span);
      }
    });
  }

  sanitizeListsForWeChat(tempEl) {
    tempEl.querySelectorAll('li').forEach(li => {
      const childNodes = Array.from(li.childNodes);
      const fragment = document.createDocumentFragment();
      
      childNodes.forEach(child => {
        if (child.nodeName === 'P') {
          while (child.firstChild) {
            fragment.appendChild(child.firstChild);
          }
          fragment.appendChild(document.createElement('br'));
          child.remove();
        } else {
          fragment.appendChild(child);
        }
      });
      
      while (li.firstChild) {
        li.removeChild(li.firstChild);
      }
      li.appendChild(fragment);
      
      let lastChild = li.lastChild;
      while (lastChild && (lastChild.nodeName === 'BR' || (lastChild.nodeType === 3 && !lastChild.textContent.trim()))) {
        const toRemove = lastChild;
        lastChild = lastChild.previousSibling;
        toRemove.remove();
      }
    });
  }

  cleanEmptyParagraphs(tempEl) {
    // 清理空段落、空引用以及空列表项（防止微信端渲染出空白的 bullet 点）
    tempEl.querySelectorAll('p, blockquote, li').forEach(el => {
      if (!el.textContent.trim() && el.innerHTML.indexOf('<img') === -1 && el.innerHTML.indexOf('<span') === -1) {
        el.remove();
      }
    });
    // 清理因空列表项被移除后可能剩下的空列表容器
    tempEl.querySelectorAll('ul, ol').forEach(el => {
      if (!el.textContent.trim() && el.querySelectorAll('img').length === 0 && el.querySelectorAll('span').length === 0) {
        el.remove();
      }
    });
  }

  convertLinksToFootnotes(tempEl) {
    const links = [];
    tempEl.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      
      if (/^https?:\/\//i.test(href) && !href.includes('mp.weixin.qq.com')) {
        links.push(href);
        const footnoteIndex = links.length;
        
        const sup = document.createElement('span');
        sup.setAttribute('style', 'font-size: 10px; color: #888888; vertical-align: super; margin-left: 2px; font-weight: normal;');
        sup.textContent = `[${footnoteIndex}]`;
        
        const parent = a.parentNode;
        if (parent) {
          const fragment = document.createDocumentFragment();
          while (a.firstChild) {
            fragment.appendChild(a.firstChild);
          }
          fragment.appendChild(sup);
          parent.replaceChild(fragment, a);
        }
      }
    });
    
    if (links.length > 0) {
      const hr = document.createElement('hr');
      hr.setAttribute('style', "border: 0; border-top: 1px solid #e0e0e0; margin: 35px 0;");
      tempEl.appendChild(hr);
      
      const footnoteTitle = document.createElement('h3');
      footnoteTitle.textContent = '💡 延伸参考与链接';
      tempEl.appendChild(footnoteTitle);
      
      const list = document.createElement('ol');
      list.setAttribute('style', 'margin: 12px 0 20px 22px; padding: 0; line-height: 1.6; font-size: 14px; color: #666666; font-family: sans-serif;');
      
      links.forEach((link, idx) => {
        const li = document.createElement('li');
        li.setAttribute('style', 'margin-bottom: 8px; word-break: break-all;');
        
        const code = document.createElement('code');
        code.setAttribute('style', 'background-color: #f7f7f7; padding: 2px 4px; border-radius: 3px; font-family: monospace; font-size: 12px; color: #444444;');
        code.textContent = link;
        
        li.appendChild(code);
        list.appendChild(li);
      });
      tempEl.appendChild(list);
    }
  }

  nodeRequest(url, method = 'GET', postData = null) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: {}
      };
      
      let bodyString = null;
      if (postData) {
        bodyString = JSON.stringify(postData);
        options.headers['Content-Type'] = 'application/json; charset=utf-8';
        options.headers['Content-Length'] = Buffer.byteLength(bodyString, 'utf8');
      }
      
      const req = https.request(options, (res) => {
        let responseData = Buffer.alloc(0);
        res.on('data', (chunk) => {
          responseData = Buffer.concat([responseData, chunk]);
        });
        res.on('end', () => {
          const resStr = responseData.toString('utf8');
          try {
            const json = JSON.parse(resStr);
            resolve(json);
          } catch (e) {
            reject(new Error(`解析微信接口响应失败: ${resStr}`));
          }
        });
      });
      
      req.on('error', (err) => {
        reject(err);
      });
      
      if (bodyString) {
        req.write(bodyString);
      }
      req.end();
    });
  }

  nodeUploadFile(url, filePath, mimeType) {
    return new Promise((resolve, reject) => {
      const boundary = '----ObsidianWeChatPublisher' + Date.now().toString(16);
      const fileName = path.basename(filePath);
      
      const fileData = fs.readFileSync(filePath);
      
      const header = `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
      const footer = `\r\n--${boundary}--\r\n`;
      
      const bodyBuffer = Buffer.concat([
        Buffer.from(header, 'utf-8'),
        fileData,
        Buffer.from(footer, 'utf-8')
      ]);
      
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuffer.length
        }
      };
      
      const req = https.request(options, (res) => {
        let responseData = Buffer.alloc(0);
        res.on('data', (chunk) => {
          responseData = Buffer.concat([responseData, chunk]);
        });
        res.on('end', () => {
          const resStr = responseData.toString('utf8');
          try {
            const json = JSON.parse(resStr);
            resolve(json);
          } catch (e) {
            reject(new Error(`解析文件上传响应失败: ${resStr}`));
          }
        });
      });
      
      req.on('error', (err) => {
        reject(err);
      });
      
      req.write(bodyBuffer);
      req.end();
    });
  }

  getMimeType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    return 'application/octet-stream';
  }

  getAbsolutePath(src, vaultRoot, noteDir) {
    if (!src) return null;
    let decoded = decodeURIComponent(src);

    if (decoded.startsWith('app://local/')) {
      return decoded.slice(12);
    }
    if (decoded.startsWith('app://local')) {
      return decoded.slice(11);
    }
    if (decoded.startsWith('file://')) {
      return decoded.slice(7);
    }

    const idx = decoded.indexOf(vaultRoot);
    if (idx >= 0) {
      return decoded.slice(idx);
    }

    if (!src.includes('://')) {
      return path.resolve(noteDir, src);
    }

    return null;
  }

  async activateView() {
    let leaf = null;
    const leaves = this.app.workspace.getLeavesOfType(WECHAT_PREVIEW_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      // Split workspace vertically to open view on the side
      leaf = this.app.workspace.getLeaf('split', 'vertical');
      await leaf.setViewState({
        type: WECHAT_PREVIEW_VIEW_TYPE,
        active: true,
      });
    }

    this.app.workspace.revealLeaf(leaf);

    // Trigger content update
    const view = leaf.view;
    if (view instanceof WeChatPreviewView) {
      await view.updateContent();
    }
  }

  async publishActiveNote(isPreview = false) {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('❌ 错误：没有打开的活动笔记');
      return;
    }

    if (activeFile.extension !== 'md') {
      new Notice('❌ 错误：当前文件不是 Markdown 笔记');
      return;
    }

    this.activeNoteFile = activeFile;

    if (isPreview) {
      await this.activateView();
      return;
    }

    const { appId, appSecret, author: defaultAuthor, layoutMode, primaryColor, fontFamily } = this.settings;

    if (!appId || !appSecret) {
      new Notice('⚠️ 提示：请在设置中配置你的微信 AppID 和 AppSecret 进行发布');
      return;
    }

    new Notice('🚀 开始同步文章到微信草稿箱...');

    try {
      const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
      const tokenData = await this.nodeRequest(tokenUrl);
      if (tokenData.errcode) {
        throw new Error(`微信 Token 获取失败: ${tokenData.errmsg}`);
      }
      const accessToken = tokenData.access_token;

      // Read Note File
      const fileContent = await this.app.vault.read(activeFile);
      const frontMatter = this.app.metadataCache.getFileCache(activeFile)?.frontmatter || {};

      // Parse metadata
      const title = frontMatter.topic || frontMatter.title || activeFile.basename;
      const author = frontMatter.persona || frontMatter.author || defaultAuthor || '作者';
      const digest = frontMatter.digest || frontMatter.推送摘要 || fileContent.slice(0, 120).replace(/[\s\r\n#*`>-]+/g, ' ').trim() + '...';

      // Remove front matter
      let markdownBody = fileContent;
      const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
      const match = fileContent.match(fmRegex);
      if (match) {
        markdownBody = fileContent.slice(match[0].length);
      }

      // Render Markdown to DOM
      const tempEl = document.createElement('div');
      const vaultRoot = this.app.vault.adapter.basePath;
      const noteDir = path.dirname(path.resolve(vaultRoot, activeFile.path));

      await MarkdownRenderer.renderMarkdown(markdownBody, tempEl, activeFile.path, this);
      this.preprocessEmbeds(tempEl);
      this.convertLinksToFootnotes(tempEl);
      this.sanitizeListsForWeChat(tempEl);
      this.cleanEmptyParagraphs(tempEl);

      // Extract and Upload Images
      const imgEls = tempEl.querySelectorAll('img');
      const imagesCache = {};
      let thumbMediaId = null;

      // Locate cover image
      let coverImgPath = null;
      if (frontMatter.cover) {
        coverImgPath = this.getAbsolutePath(frontMatter.cover, vaultRoot, noteDir);
      }

      if (!coverImgPath) {
        for (let i = 0; i < imgEls.length; i++) {
          const img = imgEls[i];
          const alt = img.getAttribute('alt') || '';
          const src = img.getAttribute('src') || '';
          if (alt === '封面' || src.includes('cover_main')) {
            coverImgPath = this.getAbsolutePath(src, vaultRoot, noteDir);
            break;
          }
        }
      }

      if (!coverImgPath && imgEls.length > 0) {
        coverImgPath = this.getAbsolutePath(imgEls[0].getAttribute('src'), vaultRoot, noteDir);
      }

      // Upload Cover
      if (coverImgPath && fs.existsSync(coverImgPath)) {
        new Notice('📸 上传文章封面图...');
        const coverMime = this.getMimeType(coverImgPath);
        const uploadCoverUrl = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${accessToken}&type=thumb`;
        const coverData = await this.nodeUploadFile(uploadCoverUrl, coverImgPath, coverMime);
        
        if (coverData.errcode) {
          throw new Error(`封面上传失败: ${coverData.errmsg}`);
        }
        thumbMediaId = coverData.media_id;
        imagesCache[coverImgPath] = thumbMediaId;
      }

      // Upload other inline images with progress feedback
      for (let i = 0; i < imgEls.length; i++) {
        const img = imgEls[i];
        const src = img.getAttribute('src');
        const imgPath = this.getAbsolutePath(src, vaultRoot, noteDir);

        if (imgPath && fs.existsSync(imgPath) && !imagesCache[imgPath]) {
          new Notice(`📸 [图片 ${i + 1}/${imgEls.length}] 同步正文图片: ${path.basename(imgPath)}...`);
          const imgMime = this.getMimeType(imgPath);
          const uploadImgUrl = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${accessToken}`;
          const imgData = await this.nodeUploadFile(uploadImgUrl, imgPath, imgMime);
          
          if (imgData.errcode) {
            console.error('WeChat uploadimg error:', imgData);
          } else {
            imagesCache[imgPath] = imgData.url;
          }
        }
      }

      // Styling based on layout settings
      let h2Style = '';
      let h3Style = '';
      let quoteStyle = '';
      let pStyle = '';
      let tableStyle = '';
      let thStyle = '';
      let tdStyle = '';
      let codeBlockStyle = '';
      let inlineCodeStyle = '';
      const fontStack = fontFamily === 'sans-serif' ? "system-ui, -apple-system, sans-serif" : (fontFamily === 'serif' ? "Georgia, STSong, serif" : "inherit");

      if (layoutMode === 'minimalist') {
        h2Style = `color: ${primaryColor}; border-bottom: 2px solid ${primaryColor}; padding-bottom: 8px; margin-top: 45px; margin-bottom: 22px; font-weight: 800; font-size: 22px; letter-spacing: 1px; font-family: ${fontStack}; text-align: left;`;
        h3Style = `color: #111111; margin-top: 32px; margin-bottom: 14px; font-weight: 700; font-size: 18px; border-left: 4px solid ${primaryColor}; padding-left: 10px; font-family: ${fontStack};`;
        quoteStyle = `background-color: #f8f8f8; border-left: 4px solid ${primaryColor}; padding: 16px 20px; margin: 20px 0; color: #555555; font-size: 15px; border-radius: 4px; line-height: 1.7; letter-spacing: 0.5px;`;
        pStyle = `font-size: 16px; line-height: 1.8; color: #333333; margin-bottom: 1.6em; text-align: justify; letter-spacing: 0.8px; font-family: ${fontStack};`;
        tableStyle = `width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; font-family: ${fontStack};`;
        thStyle = `background-color: ${primaryColor}1a; border: 1px solid #e0e0e0; padding: 10px; font-weight: bold; text-align: left;`;
        tdStyle = `border: 1px solid #e0e0e0; padding: 10px; line-height: 1.5; color: #444444;`;
        codeBlockStyle = `background-color: #f8f8f8; border-radius: 6px; padding: 16px; overflow-x: auto; font-family: Consolas, Monaco, monospace; font-size: 14px; line-height: 1.6; margin: 20px 0; border: 1px solid #eaeaea; color: #333333;`;
        inlineCodeStyle = `background-color: #f3f3f3; color: #c7254e; padding: 2px 6px; border-radius: 4px; font-family: Consolas, Monaco, monospace; font-size: 0.9em;`;
      } else if (layoutMode === 'modern_left') {
        h2Style = `color: #111111; border-left: 6px solid ${primaryColor}; padding-left: 14px; margin-top: 45px; margin-bottom: 22px; font-weight: 800; font-size: 23px; letter-spacing: 1px; font-family: ${fontStack};`;
        h3Style = `color: #222222; margin-top: 32px; margin-bottom: 14px; font-weight: 700; font-size: 19px; border-left: 4px dashed ${primaryColor}; padding-left: 10px; font-family: ${fontStack};`;
        quoteStyle = `background-color: #fcfcfc; border-left: 4px dashed ${primaryColor}; padding: 16px 20px; margin: 20px 0; color: #555555; font-size: 15px; border-radius: 4px; line-height: 1.7;`;
        pStyle = `font-size: 16px; line-height: 1.8; color: #333333; margin-bottom: 1.6em; text-align: justify; letter-spacing: 0.8px; font-family: ${fontStack};`;
        tableStyle = `width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; font-family: ${fontStack};`;
        thStyle = `background-color: #f2f2f2; border: 1px solid #dddddd; padding: 10px; font-weight: bold; text-align: left; border-bottom: 2px solid ${primaryColor};`;
        tdStyle = `border: 1px solid #dddddd; padding: 10px; line-height: 1.5; color: #333333;`;
        codeBlockStyle = `background-color: #272822; color: #f8f8f2; border-radius: 6px; padding: 16px; overflow-x: auto; font-family: Consolas, Monaco, monospace; font-size: 14px; line-height: 1.6; margin: 20px 0;`;
        inlineCodeStyle = `background-color: #f8f8f2; color: ${primaryColor}; border: 1px solid #e1e1e8; padding: 2px 6px; border-radius: 4px; font-family: Consolas, Monaco, monospace; font-size: 0.9em;`;
      } else if (layoutMode === 'corporate_box') {
        h2Style = `background-color: ${primaryColor}; color: #ffffff; padding: 10px 16px; border-radius: 6px; margin-top: 45px; margin-bottom: 22px; font-weight: 800; font-size: 20px; letter-spacing: 1.5px; display: block; font-family: ${fontStack}; box-shadow: 0 2px 8px rgba(0,0,0,0.05);`;
        h3Style = `color: ${primaryColor}; margin-top: 32px; margin-bottom: 14px; font-weight: 700; font-size: 18px; border-bottom: 1px dashed ${primaryColor}; padding-bottom: 6px; font-family: ${fontStack};`;
        quoteStyle = `background-color: #f7fafc; border-left: 4px solid ${primaryColor}; padding: 16px 20px; margin: 20px 0; color: #4a5568; font-size: 15px; border-radius: 4px; line-height: 1.7;`;
        pStyle = `font-size: 16px; line-height: 1.85; color: #2d3748; margin-bottom: 1.6em; text-align: justify; letter-spacing: 0.5px; font-family: ${fontStack};`;
        tableStyle = `width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; font-family: ${fontStack};`;
        thStyle = `background-color: ${primaryColor}; color: #ffffff; border: 1px solid #e2e8f0; padding: 10px; font-weight: bold; text-align: left;`;
        tdStyle = `border: 1px solid #e2e8f0; padding: 10px; line-height: 1.5; color: #2d3748; background-color: #fcfdfd;`;
        codeBlockStyle = `background-color: #f7fafc; border-left: 4px solid ${primaryColor}; border-radius: 0 6px 6px 0; padding: 16px; overflow-x: auto; font-family: Consolas, Monaco, monospace; font-size: 14px; line-height: 1.6; margin: 20px 0; color: #4a5568;`;
        inlineCodeStyle = `background-color: #edf2f7; color: #2d3748; padding: 2px 6px; border-radius: 4px; font-family: Consolas, Monaco, monospace; font-size: 0.9em;`;
      }

      tempEl.querySelectorAll('h2').forEach(el => el.setAttribute('style', h2Style));
      tempEl.querySelectorAll('h3').forEach(el => el.setAttribute('style', h3Style));
      tempEl.querySelectorAll('h4, h5, h6').forEach(el => el.setAttribute('style', `color: #222222; margin-top: 24px; margin-bottom: 12px; font-weight: bold; font-size: 16px; font-family: ${fontStack};`));
      tempEl.querySelectorAll('p').forEach(el => el.setAttribute('style', pStyle));
      tempEl.querySelectorAll('blockquote').forEach(el => el.setAttribute('style', quoteStyle));
      tempEl.querySelectorAll('ul, ol').forEach(el => el.setAttribute('style', `margin: 12px 0 20px 22px; padding: 0; line-height: 1.8; font-size: 16px; color: #333333; letter-spacing: 0.5px; font-family: ${fontStack};`));
      tempEl.querySelectorAll('li').forEach(el => el.setAttribute('style', "margin-bottom: 10px;"));
      tempEl.querySelectorAll('strong').forEach(el => el.setAttribute('style', `color: ${primaryColor}; font-weight: bold;`));
      tempEl.querySelectorAll('hr').forEach(el => el.setAttribute('style', "border: 0; border-top: 1px solid #e0e0e0; margin: 35px 0;"));
      tempEl.querySelectorAll('table').forEach(el => el.setAttribute('style', tableStyle));
      tempEl.querySelectorAll('th').forEach(el => el.setAttribute('style', thStyle));
      tempEl.querySelectorAll('td').forEach(el => el.setAttribute('style', tdStyle));
      tempEl.querySelectorAll('pre').forEach(el => el.setAttribute('style', codeBlockStyle));
      tempEl.querySelectorAll('code').forEach(el => {
        if (el.parentNode && el.parentNode.nodeName === 'PRE') {
          el.setAttribute('style', 'font-family: inherit; font-size: inherit; color: inherit; background: none; border: none; padding: 0; margin: 0;');
        } else {
          el.setAttribute('style', inlineCodeStyle);
        }
      });

      // Style and swap image source URLs
      tempEl.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src');
        const imgPath = this.getAbsolutePath(src, vaultRoot, noteDir);
        let displayUrl = src;
        if (imgPath) {
          displayUrl = imagesCache[imgPath] || src;
        }
        img.setAttribute('src', displayUrl);
        img.setAttribute('style', "max-width: 100%; border-radius: 8px; display: block; margin: 24px auto; box-shadow: 0 4px 16px rgba(0,0,0,0.04);");
      });

      const finalContentHtml = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 16px; color: #333333; max-width: 677px; margin: 0 auto; padding: 15px; box-sizing: border-box;">${tempEl.innerHTML}</div>`;

      if (!thumbMediaId) {
        throw new Error('缺少有效的封面图片 media_id，无法创建微信草稿。');
      }

      new Notice('📡 发送图文内容至微信草稿箱...');
      const draftUrl = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${accessToken}`;
      const payload = {
        articles: [
          {
            title: title,
            author: author,
            digest: digest,
            content: finalContentHtml,
            thumb_media_id: thumbMediaId,
            need_open_comment: 0,
            only_fans_can_comment: 0
          }
        ]
      };

      const draftData = await this.nodeRequest(draftUrl, 'POST', payload);
      if (draftData.errcode) {
        throw new Error(`草稿创建失败: ${draftData.errmsg}`);
      }

      new Notice('🎉 成功：已成功推送到微信草稿箱！');
      console.log('WeChat Publisher Success:', draftData.media_id);

    } catch (err) {
      new Notice(`❌ 同步失败：${err.message}`);
      console.error(err);
    }
  }
}

class WeChatPreviewView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return WECHAT_PREVIEW_VIEW_TYPE;
  }

  getDisplayText() {
    return '微信排版预览';
  }

  getIcon() {
    return 'phone';
  }

  async onOpen() {
    this.renderLayout();
    await this.updateContent();
  }

  renderLayout() {
    const container = this.contentEl;
    container.empty();
    container.setAttribute('style', 'display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background-color: var(--background-secondary);');

    // 1. Live Control Panel
    const controlBar = container.createDiv();
    controlBar.setAttribute('style', 'display: flex; flex-wrap: wrap; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border-color); background-color: var(--background-primary); align-items: center; justify-content: flex-start;');

    // Dropdown for layoutMode
    controlBar.createSpan({ text: '排版版式:', attr: { style: 'font-size: 13px; font-weight: 600; color: var(--text-normal);' } });
    const layoutSelect = controlBar.createEl('select', { attr: { style: 'padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color); background-color: var(--background-primary); font-size: 13px; color: var(--text-normal); cursor: pointer;' } });
    layoutSelect.createEl('option', { value: 'minimalist', text: '极细线框风' });
    layoutSelect.createEl('option', { value: 'modern_left', text: '现代左竖风' });
    layoutSelect.createEl('option', { value: 'corporate_box', text: '商务色块风' });
    layoutSelect.value = this.plugin.settings.layoutMode;
    layoutSelect.onchange = async () => {
      this.plugin.settings.layoutMode = layoutSelect.value;
      await this.plugin.saveSettings();
      await this.updateContent();
    };

    // Color Picker Controls
    controlBar.createSpan({ text: '主题色:', attr: { style: 'font-size: 13px; font-weight: 600; color: var(--text-normal); margin-left: 8px;' } });
    const colorPicker = controlBar.createEl('input', { type: 'color', attr: { style: 'width: 28px; height: 28px; border: 1px solid var(--border-color); border-radius: 4px; padding: 0; background: none; cursor: pointer;' } });
    colorPicker.value = this.plugin.settings.primaryColor || '#d4af37';

    const colorInput = controlBar.createEl('input', { type: 'text', attr: { style: 'width: 78px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color); background-color: var(--background-primary); font-size: 13px; color: var(--text-normal); text-align: center;', placeholder: '#d4af37' } });
    colorInput.value = this.plugin.settings.primaryColor || '#d4af37';

    const updateColorSetting = async (colorVal) => {
      this.plugin.settings.primaryColor = colorVal;
      colorPicker.value = colorVal;
      colorInput.value = colorVal;
      await this.plugin.saveSettings();
      await this.updateContent();
    };

    colorPicker.oninput = () => updateColorSetting(colorPicker.value);
    colorInput.onchange = () => {
      let val = colorInput.value.trim();
      if (!val.startsWith('#')) val = '#' + val;
      if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
        updateColorSetting(val);
      } else {
        new Notice('❌ 提示：请输入正确的十六进制颜色代码 (Hex, 如 #d4af37)');
      }
    };

    // Font Family Select
    controlBar.createSpan({ text: '阅读字体:', attr: { style: 'font-size: 13px; font-weight: 600; color: var(--text-normal); margin-left: 8px;' } });
    const fontSelect = controlBar.createEl('select', { attr: { style: 'padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color); background-color: var(--background-primary); font-size: 13px; color: var(--text-normal); cursor: pointer;' } });
    fontSelect.createEl('option', { value: 'sans-serif', text: '雅黑体 (无衬线)' });
    fontSelect.createEl('option', { value: 'serif', text: '宋雅体 (有衬线)' });
    fontSelect.value = this.plugin.settings.fontFamily || 'sans-serif';
    fontSelect.onchange = async () => {
      this.plugin.settings.fontFamily = fontSelect.value;
      await this.plugin.saveSettings();
      await this.updateContent();
    };

    // Spacing
    const spacer = controlBar.createDiv({ attr: { style: 'flex: 1;' } });

    // Action Buttons
    const refreshBtn = controlBar.createEl('button', { text: '🔄 刷新', attr: { style: 'padding: 5px 12px; font-size: 13px; cursor: pointer; border-radius: 4px; font-weight: 500;' } });
    refreshBtn.onclick = async () => {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile && activeFile.extension === 'md') {
        this.plugin.activeNoteFile = activeFile;
      }
      await this.updateContent();
      new Notice('🔄 预览内容已刷新');
    };

    const uploadBtn = controlBar.createEl('button', { 
      text: '📡 同步到草稿箱', 
      attr: { style: 'padding: 5px 14px; font-size: 13px; background-color: var(--interactive-accent); color: var(--text-on-accent); border: none; border-radius: 4px; cursor: pointer; font-weight: 600;' } 
    });
    uploadBtn.onclick = () => {
      this.plugin.publishActiveNote(false);
    };

    // 2. Main Simulator Display Pane
    const displayPane = container.createDiv();
    displayPane.setAttribute('style', 'flex: 1; display: flex; justify-content: center; align-items: flex-start; padding: 24px; overflow-y: auto; min-height: 0;');

    // Standard WeChat Simulator Container (Always Light Mode styling inside)
    const simulatorFrame = displayPane.createDiv();
    simulatorFrame.setAttribute('style', 'border: 12px solid #2a2a2a; border-radius: 40px; padding: 28px 24px; width: 440px; min-height: 720px; background-color: #ffffff; box-shadow: 0 12px 36px rgba(0,0,0,0.15); box-sizing: border-box; margin-bottom: 24px;');

    this.simTitleEl = simulatorFrame.createEl('h1');
    this.simTitleEl.setAttribute('style', 'font-size: 22px; font-weight: bold; line-height: 1.4; margin-top: 8px; margin-bottom: 12px; color: #000000; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif;');

    const meta = simulatorFrame.createDiv();
    meta.setAttribute('style', 'font-size: 13px; color: #8c8c8c; margin-bottom: 24px; display: flex; gap: 10px; font-family: sans-serif;');
    const dateSpan = meta.createSpan();
    const today = new Date();
    dateSpan.setText(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);

    this.simAuthorEl = meta.createSpan();
    this.simAuthorEl.setAttribute('style', 'color: #576b95; font-weight: 500;');

    this.simContentEl = simulatorFrame.createDiv();
  }

  async updateContent() {
    const activeFile = this.plugin.activeNoteFile || this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== 'md') {
      this.simTitleEl.setText('没有选中活动笔记');
      this.simAuthorEl.setText('');
      this.simContentEl.setText('请在编辑器中打开一篇 Markdown 笔记，或者点击上面的刷新按钮。');
      return;
    }

    const { primaryColor, layoutMode, fontFamily } = this.plugin.settings;

    try {
      const fileContent = await this.app.vault.read(activeFile);
      const frontMatter = this.app.metadataCache.getFileCache(activeFile)?.frontmatter || {};

      const title = frontMatter.topic || frontMatter.title || activeFile.basename;
      const author = frontMatter.persona || frontMatter.author || this.plugin.settings.author || '作者';

      this.simTitleEl.setText(title);
      this.simAuthorEl.setText(author);

      // Parse markdown to HTML
      let markdownBody = fileContent;
      const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
      const match = fileContent.match(fmRegex);
      if (match) {
        markdownBody = fileContent.slice(match[0].length);
      }

      const tempEl = document.createElement('div');
      await MarkdownRenderer.renderMarkdown(markdownBody, tempEl, activeFile.path, this);
      this.plugin.preprocessEmbeds(tempEl);
      this.plugin.convertLinksToFootnotes(tempEl);
      this.plugin.sanitizeListsForWeChat(tempEl);
      this.plugin.cleanEmptyParagraphs(tempEl);

      // Styling parameters
      let h2Style = '';
      let h3Style = '';
      let quoteStyle = '';
      let pStyle = '';
      let tableStyle = '';
      let thStyle = '';
      let tdStyle = '';
      let codeBlockStyle = '';
      let inlineCodeStyle = '';
      const fontStack = fontFamily === 'sans-serif' ? "system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', sans-serif" : "Georgia, 'Nimbus Roman No9 L', STSong, 'Songti SC', serif";

      if (layoutMode === 'minimalist') {
        h2Style = `color: ${primaryColor}; border-bottom: 2px solid ${primaryColor}; padding-bottom: 8px; margin-top: 45px; margin-bottom: 22px; font-weight: 800; font-size: 22px; letter-spacing: 1px; font-family: ${fontStack}; text-align: left;`;
        h3Style = `color: #111111; margin-top: 32px; margin-bottom: 14px; font-weight: 700; font-size: 18px; border-left: 4px solid ${primaryColor}; padding-left: 10px; font-family: ${fontStack};`;
        quoteStyle = `background-color: #f8f8f8; border-left: 4px solid ${primaryColor}; padding: 16px 20px; margin: 20px 0; color: #555555; font-size: 15px; border-radius: 4px; line-height: 1.7; letter-spacing: 0.5px; font-family: ${fontStack};`;
        pStyle = `font-size: 16px; line-height: 1.8; color: #333333; margin-bottom: 1.6em; text-align: justify; letter-spacing: 0.8px; font-family: ${fontStack};`;
        tableStyle = `width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; font-family: ${fontStack};`;
        thStyle = `background-color: ${primaryColor}1a; border: 1px solid #e0e0e0; padding: 10px; font-weight: bold; text-align: left;`;
        tdStyle = `border: 1px solid #e0e0e0; padding: 10px; line-height: 1.5; color: #444444;`;
        codeBlockStyle = `background-color: #f8f8f8; border-radius: 6px; padding: 16px; overflow-x: auto; font-family: Consolas, Monaco, monospace; font-size: 14px; line-height: 1.6; margin: 20px 0; border: 1px solid #eaeaea; color: #333333;`;
        inlineCodeStyle = `background-color: #f3f3f3; color: #c7254e; padding: 2px 6px; border-radius: 4px; font-family: Consolas, Monaco, monospace; font-size: 0.9em;`;
      } else if (layoutMode === 'modern_left') {
        h2Style = `color: #111111; border-left: 6px solid ${primaryColor}; padding-left: 14px; margin-top: 45px; margin-bottom: 22px; font-weight: 800; font-size: 23px; letter-spacing: 1px; font-family: ${fontStack};`;
        h3Style = `color: #222222; margin-top: 32px; margin-bottom: 14px; font-weight: 700; font-size: 19px; border-left: 4px dashed ${primaryColor}; padding-left: 10px; font-family: ${fontStack};`;
        quoteStyle = `background-color: #fcfcfc; border-left: 4px dashed ${primaryColor}; padding: 16px 20px; margin: 20px 0; color: #555555; font-size: 15px; border-radius: 4px; line-height: 1.7; font-family: ${fontStack};`;
        pStyle = `font-size: 16px; line-height: 1.8; color: #333333; margin-bottom: 1.6em; text-align: justify; letter-spacing: 0.8px; font-family: ${fontStack};`;
        tableStyle = `width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; font-family: ${fontStack};`;
        thStyle = `background-color: #f2f2f2; border: 1px solid #dddddd; padding: 10px; font-weight: bold; text-align: left; border-bottom: 2px solid ${primaryColor};`;
        tdStyle = `border: 1px solid #dddddd; padding: 10px; line-height: 1.5; color: #333333;`;
        codeBlockStyle = `background-color: #272822; color: #f8f8f2; border-radius: 6px; padding: 16px; overflow-x: auto; font-family: Consolas, Monaco, monospace; font-size: 14px; line-height: 1.6; margin: 20px 0;`;
        inlineCodeStyle = `background-color: #f8f8f2; color: ${primaryColor}; border: 1px solid #e1e1e8; padding: 2px 6px; border-radius: 4px; font-family: Consolas, Monaco, monospace; font-size: 0.9em;`;
      } else if (layoutMode === 'corporate_box') {
        h2Style = `background-color: ${primaryColor}; color: #ffffff; padding: 10px 16px; border-radius: 6px; margin-top: 45px; margin-bottom: 22px; font-weight: 800; font-size: 20px; letter-spacing: 1.5px; display: block; font-family: ${fontStack}; box-shadow: 0 2px 8px rgba(0,0,0,0.05);`;
        h3Style = `color: ${primaryColor}; margin-top: 32px; margin-bottom: 14px; font-weight: 700; font-size: 18px; border-bottom: 1px dashed ${primaryColor}; padding-bottom: 6px; font-family: ${fontStack};`;
        quoteStyle = `background-color: #f7fafc; border-left: 4px solid ${primaryColor}; padding: 16px 20px; margin: 20px 0; color: #4a5568; font-size: 15px; border-radius: 4px; line-height: 1.7; font-family: ${fontStack};`;
        pStyle = `font-size: 16px; line-height: 1.85; color: #2d3748; margin-bottom: 1.6em; text-align: justify; letter-spacing: 0.5px; font-family: ${fontStack};`;
        tableStyle = `width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; font-family: ${fontStack};`;
        thStyle = `background-color: ${primaryColor}; color: #ffffff; border: 1px solid #e2e8f0; padding: 10px; font-weight: bold; text-align: left;`;
        tdStyle = `border: 1px solid #e2e8f0; padding: 10px; line-height: 1.5; color: #2d3748; background-color: #fcfdfd;`;
        codeBlockStyle = `background-color: #f7fafc; border-left: 4px solid ${primaryColor}; border-radius: 0 6px 6px 0; padding: 16px; overflow-x: auto; font-family: Consolas, Monaco, monospace; font-size: 14px; line-height: 1.6; margin: 20px 0; color: #4a5568;`;
        inlineCodeStyle = `background-color: #edf2f7; color: #2d3748; padding: 2px 6px; border-radius: 4px; font-family: Consolas, Monaco, monospace; font-size: 0.9em;`;
      }

      // Formats
      tempEl.querySelectorAll('h2').forEach(el => el.setAttribute('style', h2Style));
      tempEl.querySelectorAll('h3').forEach(el => el.setAttribute('style', h3Style));
      tempEl.querySelectorAll('h4, h5, h6').forEach(el => el.setAttribute('style', `color: #222222; margin-top: 24px; margin-bottom: 12px; font-weight: bold; font-size: 16px; font-family: ${fontStack};`));
      tempEl.querySelectorAll('p').forEach(el => el.setAttribute('style', pStyle));
      tempEl.querySelectorAll('blockquote').forEach(el => el.setAttribute('style', quoteStyle));
      tempEl.querySelectorAll('ul, ol').forEach(el => el.setAttribute('style', `margin: 12px 0 20px 22px; padding: 0; line-height: 1.8; font-size: 16px; color: #333333; letter-spacing: 0.5px; font-family: ${fontStack};`));
      tempEl.querySelectorAll('li').forEach(el => el.setAttribute('style', "margin-bottom: 10px;"));
      tempEl.querySelectorAll('strong').forEach(el => el.setAttribute('style', `color: ${primaryColor}; font-weight: bold;`));
      tempEl.querySelectorAll('hr').forEach(el => el.setAttribute('style', "border: 0; border-top: 1px solid #e0e0e0; margin: 35px 0;"));
      tempEl.querySelectorAll('table').forEach(el => el.setAttribute('style', tableStyle));
      tempEl.querySelectorAll('th').forEach(el => el.setAttribute('style', thStyle));
      tempEl.querySelectorAll('td').forEach(el => el.setAttribute('style', tdStyle));
      tempEl.querySelectorAll('pre').forEach(el => el.setAttribute('style', codeBlockStyle));
      tempEl.querySelectorAll('code').forEach(el => {
        if (el.parentNode && el.parentNode.nodeName === 'PRE') {
          el.setAttribute('style', 'font-family: inherit; font-size: inherit; color: inherit; background: none; border: none; padding: 0; margin: 0;');
        } else {
          el.setAttribute('style', inlineCodeStyle);
        }
      });

      // Solve local absolute/relative image path loading in Obsidian view
      const vaultRoot = this.app.vault.adapter.basePath;
      let debugText = `Active Note: ${activeFile.path}\nVault Root: ${vaultRoot}\n`;

      tempEl.querySelectorAll('img').forEach((img, idx) => {
        const src = img.getAttribute('src');
        debugText += `Image [${idx}] Original Src: ${src}\n`;
        if (!src) return;
        
        // Decode to handle URL-encoded paths
        const decodedSrc = decodeURIComponent(src);
        debugText += `  Decoded Src: ${decodedSrc}\n`;
        
        // Try finding via Obsidian metadata cache
        let file = this.app.metadataCache.getFirstLinkpathDest(decodedSrc, activeFile.path);
        
        // If not found directly, check if it's a relative path and try resolving relative to note folder
        if (!file && !src.includes('://')) {
          const noteDir = path.dirname(activeFile.path);
          const relativePath = path.normalize(path.join(noteDir, decodedSrc));
          debugText += `  Inferred path relative to vault: ${relativePath}\n`;
          file = this.app.vault.getAbstractFileByPath(relativePath);
        }
        
        let displayUrl = src;
        if (file) {
          displayUrl = this.app.vault.getResourcePath(file);
          debugText += `  Found TFile: ${file.path}\n`;
          debugText += `  Obsidian Resource Path: ${displayUrl}\n`;
        } else {
          debugText += `  TFile NOT found for this src\n`;
        }

        img.setAttribute('src', displayUrl);
        img.setAttribute('style', "max-width: 100%; border-radius: 8px; display: block; margin: 24px auto; box-shadow: 0 4px 16px rgba(0,0,0,0.04);");
      });

      try {
        debugText += `\n--- Raw HTML Output ---\n${tempEl.innerHTML}\n`;
        fs.writeFileSync(path.join(vaultRoot, 'img_debug.txt'), debugText);
      } catch (err) {
        console.error('Debug write failed', err);
      }

      this.simContentEl.empty();
      this.simContentEl.appendChild(tempEl);
      this.simContentEl.setAttribute('style', `font-family: ${fontStack};`);

    } catch (e) {
      new Notice(`❌ 渲染预览失败：${e.message}`);
      console.error(e);
    }
  }

  async onClose() {
    // Cleanup
  }
}

class WeChatPublisherSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: '微信公众号草稿箱一键同步配置' });

    containerEl.createEl('p', {
      text: '由 铭泽律师 (Maxwell) 开发制作，旨在为法律人与自媒体创作者提供高效、安全的本地微信排版与一键同步工具。本插件完全免费，所有密钥均本地化存储，保障数据隐私。',
      attr: { style: 'font-size: 13px; color: var(--text-muted); line-height: 1.5; margin-bottom: 20px;' }
    });

    new Setting(containerEl)
      .setName('默认排版版式')
      .setDesc('选择你喜欢的默认排版大骨架')
      .addDropdown(dropdown => dropdown
        .addOption('minimalist', '「极细线框风」H2下划线排版')
        .addOption('modern_left', '「现代左竖风」H2左侧粗竖线排版')
        .addOption('corporate_box', '「商务色块风」H2实色背景框排版')
        .setValue(this.plugin.settings.layoutMode || 'minimalist')
        .onChange(async (value) => {
          this.plugin.settings.layoutMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认主题色 (Primary Color)')
      .setDesc('设置微信公众号的主颜色 (Hex 格式，如 金色 #d4af37)')
      .addText(text => text
        .setPlaceholder('#d4af37')
        .setValue(this.plugin.settings.primaryColor || '#d4af37')
        .onChange(async (value) => {
          this.plugin.settings.primaryColor = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认阅读字体')
      .setDesc('默认预览与排版中使用的字体')
      .addDropdown(dropdown => dropdown
        .addOption('sans-serif', '微软雅黑 (无衬线)')
        .addOption('serif', '宋体/有衬线 (宋雅体)')
        .setValue(this.plugin.settings.fontFamily || 'sans-serif')
        .onChange(async (value) => {
          this.plugin.settings.fontFamily = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('AppID')
      .setDesc('微信公众号开发者接口中的 AppID')
      .addText(text => text
        .setPlaceholder('wxxxxxxxxxxxxxxxx')
        .setValue(this.plugin.settings.appId)
        .onChange(async (value) => {
          this.plugin.settings.appId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('AppSecret')
      .setDesc('微信公众号开发者接口中的 AppSecret')
      .addText(text => text
        .setPlaceholder('请输入 AppSecret')
        .setValue(this.plugin.settings.appSecret)
        .onChange(async (value) => {
          this.plugin.settings.appSecret = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认作者')
      .setDesc('微信草稿中显示的默认作者')
      .addText(text => text
        .setPlaceholder('例如：铭泽律师')
        .setValue(this.plugin.settings.author)
        .onChange(async (value) => {
          this.plugin.settings.author = value.trim();
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = WeChatPublisherPlugin;
