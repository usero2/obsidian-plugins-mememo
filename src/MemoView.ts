import { ItemView, Notice, TFile, WorkspaceLeaf, parseYaml } from 'obsidian';
import type MemomoPlugin from './main';
import type { Memo, MemoAttachment, PendingAttachment } from './types';

export const MEMO_VIEW_TYPE = 'mememo-view';

const MEMO_FOLDER   = '_mememo';
const ASSETS_FOLDER = '_mememo/assets';

export class MemoView extends ItemView {
	private plugin: MemomoPlugin;
	private editorEl!: HTMLElement;
	private composerAttsEl!: HTMLElement;
	private feedEl!: HTMLElement;
	private calendarEl!: HTMLElement;
	private tagsEl!: HTMLElement;
	private calMonth = new Date();
	private pendingAtts: PendingAttachment[] = [];
	private cachedMemos: Memo[] = [];
	private cleanups: (() => void)[] = [];
	private currentFilter = '';
	private includedTags: Set<string> = new Set();
	private excludedTags: Set<string> = new Set();

	constructor(leaf: WorkspaceLeaf, plugin: MemomoPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return MEMO_VIEW_TYPE; }
	getDisplayText() { return 'MeMemo'; }
	getIcon() { return 'pencil'; }

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass('mm-root');
		this.buildSidebar(this.contentEl);
		this.buildMain(this.contentEl);
		await this.refresh();
	}

	// ─── VAULT HELPERS ───────────────────────────────────────

	private get vault() { return this.plugin.app.vault; }

	private async ensureFolders() {
		if (!this.vault.getAbstractFileByPath(MEMO_FOLDER)) {
			await this.vault.createFolder(MEMO_FOLDER);
		}
		if (!this.vault.getAbstractFileByPath(ASSETS_FOLDER)) {
			await this.vault.createFolder(ASSETS_FOLDER);
		}
	}

	private async loadMemos(): Promise<Memo[]> {
		const files = this.vault.getFiles().filter(
			f => f.path.startsWith(MEMO_FOLDER + '/') &&
				!f.path.startsWith(ASSETS_FOLDER + '/') &&
				f.extension === 'md'
		);
		const memos: Memo[] = [];
		for (const file of files) {
			const raw = await this.vault.read(file);
			const memo = this.parseMemoFile(raw, file.path);
			memos.push(memo);
		}
		return memos.sort((a, b) => b.createdAt - a.createdAt);
	}

	private parseMemoFile(raw: string, filePath: string): Memo {
		const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
		if (!match) {
			return { filePath, content: raw.trim(), attachments: [], tags: [], createdAt: Date.now(), updatedAt: Date.now(), isPrivate: true };
		}

		let fm: Record<string, unknown> = {};
		try { fm = parseYaml(match[1]) as Record<string, unknown>; } catch { /* ignore */ }

		const body = match[2] ?? '';

		// Pull ![[path]] refs → attachments
		const attachments: MemoAttachment[] = [];
		const attRegex = /!\[\[([^\]]+)\]\]\n?/g;
		let m: RegExpExecArray | null;
		while ((m = attRegex.exec(body)) !== null) {
			const vaultPath = m[1];
			const name = vaultPath.split('/').pop() ?? vaultPath;
			const type = /\.(png|jpg|jpeg|gif|webp|avif|svg|bmp)$/i.test(name) ? 'image'
				: /\.(mp4|webm|mov|avi|mkv|m4v|ogv)$/i.test(name) ? 'video'
				: /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(name) ? 'audio' : 'file';
			attachments.push({ id: vaultPath, type, name, vaultPath });
		}

		const content = body.replace(/!\[\[[^\]]+\]\]\n?/g, '').trim();
		const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
		const createdAt = fm.created ? new Date(fm.created as string).getTime() : Date.now();
		const updatedAt = fm.updated ? new Date(fm.updated as string).getTime() : createdAt;

		return { filePath, content, attachments, tags, createdAt, updatedAt, isPrivate: fm.private !== false };
	}

	private buildMemoMarkdown(content: string, tags: string[], attachments: MemoAttachment[], _isPrivate?: boolean, created?: string): string {
		const now = new Date().toISOString();
		const tagsYaml = tags.length ? `[${tags.join(', ')}]` : '[]';
		let md = `---\ncreated: "${created ?? now}"\nupdated: "${now}"\ntags: ${tagsYaml}\n---\n\n`;
		md += content;
		if (attachments.length) {
			md += '\n\n' + attachments.map(a => `![[${a.vaultPath}]]`).join('\n');
		}
		return md;
	}

	private async saveAttachmentToVault(att: PendingAttachment): Promise<MemoAttachment> {
		const ts = Date.now();
		// Sanitise filename: keep extension, prepend timestamp
		const safeName = att.name.replace(/[\\/:*?"<>|]/g, '_');
		const vaultPath = `${ASSETS_FOLDER}/${ts}-${safeName}`;
		const buffer = this.dataUrlToBuffer(att.dataUrl);
		await this.vault.adapter.writeBinary(vaultPath, buffer);
		return { id: vaultPath, type: att.type, name: att.name, vaultPath };
	}

	private dataUrlToBuffer(dataUrl: string): ArrayBuffer {
		const base64 = dataUrl.split(',')[1];
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes.buffer;
	}

	/** Get the Electron resource URL for a vault file path (for <img src>). */
	private getImgSrc(vaultPath: string): string {
		const file = this.vault.getAbstractFileByPath(vaultPath);
		if (file instanceof TFile) return this.vault.getResourcePath(file);
		return '';
	}

	// ─── SIDEBAR ──────────────────────────────────────────────

	private buildSidebar(root: HTMLElement) {
		const sb = root.createDiv('mm-sidebar');

		const sw = sb.createDiv('mm-search');
		const ic = sw.createSpan('mm-search-icon');
		ic.innerHTML = SVG.search;
		const si = sw.createEl('input', {
			cls: 'mm-search-input',
			attr: { placeholder: 'Search memos...' },
		});
		si.oninput = () => { this.currentFilter = si.value; this.refresh(si.value); };

		this.calendarEl = sb.createDiv('mm-cal-wrap');

		const sec = sb.createDiv('mm-section');
		const secHeader = sec.createDiv('mm-section-header');
		secHeader.createSpan({ cls: 'mm-section-title', text: 'Tags' });
		const resetBtn = secHeader.createEl('button', { cls: 'mm-reset-btn', text: 'Reset' });
		resetBtn.onclick = () => {
			this.includedTags.clear();
			this.excludedTags.clear();
			this.refresh(this.currentFilter);
		};
		this.tagsEl = sec.createDiv('mm-tags');
	}

	private renderCalendar(memos: Memo[]) {
		this.calendarEl.empty();
		const year = this.calMonth.getFullYear();
		const month = this.calMonth.getMonth();
		const today = new Date();

		const memoDays = new Set(memos.map(m => {
			const d = new Date(m.createdAt);
			return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
		}));

		const nav = this.calendarEl.createDiv('mm-cal-nav');
		const prev = nav.createEl('button', { cls: 'mm-icon-btn' });
		prev.innerHTML = SVG.chevronLeft;
		prev.onclick = () => { this.calMonth = new Date(year, month - 1, 1); this.renderCalendar(memos); };

		nav.createSpan({ cls: 'mm-cal-month', text: this.calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) });

		const next = nav.createEl('button', { cls: 'mm-icon-btn' });
		next.innerHTML = SVG.chevronRight;
		next.onclick = () => { this.calMonth = new Date(year, month + 1, 1); this.renderCalendar(memos); };

		const grid = this.calendarEl.createDiv('mm-cal-grid');
		for (const d of ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']) grid.createDiv({ cls: 'mm-cal-dh', text: d });

		const firstDay = new Date(year, month, 1).getDay();
		const daysInMonth = new Date(year, month + 1, 0).getDate();
		const prevCount = new Date(year, month, 0).getDate();

		for (let i = 0; i < firstDay; i++) grid.createDiv({ cls: 'mm-cal-d mm-cal-other', text: String(prevCount - firstDay + 1 + i) });

		for (let d = 1; d <= daysInMonth; d++) {
			const key = `${year}-${month}-${d}`;
			const isToday = d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
			const hasMemo = memoDays.has(key);
			const cls = ['mm-cal-d', isToday ? 'mm-today' : '', hasMemo ? 'mm-has-memo' : ''].filter(Boolean).join(' ');
			const cell = grid.createDiv({ cls, text: String(d) });
			if (hasMemo) cell.onclick = () => this.refresh('', new Date(year, month, d));
		}

		const filled = firstDay + daysInMonth;
		const trailing = filled % 7 === 0 ? 0 : 7 - (filled % 7);
		for (let i = 1; i <= trailing; i++) grid.createDiv({ cls: 'mm-cal-d mm-cal-other', text: String(i) });
	}

	private renderTags(memos: Memo[]) {
		this.tagsEl.empty();
		const counts = new Map<string, number>();
		for (const m of memos) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);

		if (!counts.size) { this.tagsEl.createDiv({ cls: 'mm-empty-hint', text: 'No tags yet' }); return; }

		for (const [tag, n] of [...counts.entries()].sort()) {
			const chip = this.tagsEl.createDiv('mm-tag-chip');
			if (this.includedTags.has(tag)) chip.addClass('is-included');
			else if (this.excludedTags.has(tag)) chip.addClass('is-excluded');
			chip.createSpan({ cls: 'mm-tag-hash', text: '#' });
			chip.createSpan({ cls: 'mm-tag-name', text: tag });
			chip.createSpan({ cls: 'mm-tag-count', text: String(n) });
			chip.onclick = () => {
				if (this.includedTags.has(tag)) {
					this.includedTags.delete(tag);
					this.excludedTags.add(tag);
				} else if (this.excludedTags.has(tag)) {
					this.excludedTags.delete(tag);
				} else {
					this.includedTags.add(tag);
				}
				this.refresh(this.currentFilter);
			};
		}
	}

	// ─── MAIN ────────────────────────────────────────────────

	private buildMain(root: HTMLElement) {
		const main = root.createDiv('mm-main');
		this.buildComposer(main);
		this.feedEl = main.createDiv('mm-feed');
	}

	private buildComposer(parent: HTMLElement) {
		const composer = parent.createDiv('mm-composer');

		const fi = document.createElement('input');
		fi.type = 'file';
		fi.multiple = true;
		fi.style.display = 'none';
		composer.appendChild(fi);
		fi.onchange = async () => {
			if (fi.files?.length) await this.handleFiles(Array.from(fi.files));
			fi.value = '';
		};

		this.editorEl = composer.createDiv('mm-editor');
		this.editorEl.contentEditable = 'true';
		this.editorEl.setAttribute('data-placeholder', 'Any thoughts...');

		this.composerAttsEl = composer.createDiv('mm-composer-atts');

		const tb = composer.createDiv('mm-toolbar');
		const tbl = tb.createDiv('mm-tb-left');

		const buttons: [string, string, () => void][] = [
			['Tag (#)',      SVG.tag,       () => this.insertAtCursor('#')],
			['Todo list',   SVG.checkbox,   () => this.insertAtCursor('\n- [ ] ')],
			['Attach file', SVG.paperclip,  () => fi.click()],
		];
		for (const [title, svg, fn] of buttons) {
			const btn = tbl.createEl('button', { cls: 'mm-tb-btn', attr: { title } });
			btn.innerHTML = svg;
			btn.onclick = fn;
		}

		const tbr = tb.createDiv('mm-tb-right');
		const saveBtn = tbr.createEl('button', { cls: 'mm-save-btn', text: 'Save' });
		saveBtn.onclick = () => this.save();

		// Drag & drop — detect vault-file drag vs OS-file drag
		composer.addEventListener('dragover', (e) => {
			e.preventDefault();
			const isVault = this.getVaultDragFiles().length > 0;
			composer.classList.toggle('is-drop-link', isVault);
			composer.classList.toggle('is-drop', !isVault);
		});
		composer.addEventListener('dragleave', (e) => {
			if (!composer.contains(e.relatedTarget as Node)) {
				composer.classList.remove('is-drop', 'is-drop-link');
			}
		});
		composer.addEventListener('drop', async (e) => {
			e.preventDefault();
			composer.classList.remove('is-drop', 'is-drop-link');

			// Vault files dragged from the Obsidian navigator
			const vaultFiles = this.getVaultDragFiles();
			if (vaultFiles.length) {
				for (const vf of vaultFiles) {
					const isImage = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(vf.name);
					const linkPath = vf.extension === 'md' ? vf.path.replace(/\.md$/, '') : vf.path;
					this.insertAtCursor((isImage ? `![[${linkPath}]]` : `[[${linkPath}]]`) + ' ');
				}
				return;
			}

			// OS files dragged from outside Obsidian → attach to memo
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length) await this.handleFiles(files);
		});

		// Paste images from clipboard
		this.editorEl.addEventListener('paste', async (e) => {
			const imgs = Array.from(e.clipboardData?.items ?? []).filter(i => i.type.startsWith('image/'));
			if (!imgs.length) return;
			e.preventDefault();
			await this.handleFiles(imgs.map(i => i.getAsFile()!).filter(Boolean));
		});

		// Ctrl/Cmd+Enter to save — use document capture so Obsidian doesn't swallow the shortcut
		const onSaveKey = (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && this.editorEl.contains(e.target as Node)) {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				this.save();
			}
		};
		document.addEventListener('keydown', onSaveKey, true);
		this.cleanups.push(() => document.removeEventListener('keydown', onSaveKey, true));
	}

	private insertAtCursor(text: string) {
		this.editorEl.focus();
		const sel = window.getSelection();
		if (!sel?.rangeCount) return;
		const range = sel.getRangeAt(0);
		range.deleteContents();
		const node = document.createTextNode(text);
		range.insertNode(node);
		range.setStartAfter(node);
		range.setEndAfter(node);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	private async handleFiles(files: File[]) {
		for (const file of files) {
			const dataUrl = await this.toDataUrl(file);
			const att: PendingAttachment = {
				id: Math.random().toString(36).slice(2) + Date.now(),
				type: file.type.startsWith('image/') ? 'image'
				: file.type.startsWith('video/') ? 'video'
				: file.type.startsWith('audio/') ? 'audio' : 'file',
				name: file.name,
				size: file.size,
				dataUrl,
			};
			this.pendingAtts.push(att);
			this.renderPendingPreview(att);
		}
	}

	private renderPendingPreview(att: PendingAttachment) {
		const item = this.composerAttsEl.createDiv('mm-att-item');
		if (att.type === 'image') {
			const img = item.createEl('img', { cls: 'mm-att-thumb' });
			img.src = att.dataUrl;
			img.alt = att.name;
		} else if (att.type === 'video') {
			const wrap = item.createDiv('mm-att-video-wrap');
			const playEl = wrap.createDiv('mm-play-overlay');
			playEl.innerHTML = SVG.play;
			this.generateVideoThumbnail(att.dataUrl).then(thumb => {
				if (thumb) {
					const img = document.createElement('img');
					img.className = 'mm-att-thumb';
					img.src = thumb;
					wrap.insertBefore(img, playEl);
				}
			});
		} else {
			const chip = item.createDiv('mm-att-chip');
			chip.innerHTML = `${SVG.file} <span>${att.name}</span>`;
		}
		const del = item.createEl('button', { cls: 'mm-att-del', text: '×' });
		del.onclick = () => {
			this.pendingAtts = this.pendingAtts.filter(a => a.id !== att.id);
			item.remove();
		};
	}

	private toDataUrl(file: File): Promise<string> {
		return new Promise((res, rej) => {
			const r = new FileReader();
			r.onload = () => res(r.result as string);
			r.onerror = rej;
			r.readAsDataURL(file);
		});
	}

	private async save() {
		const content = this.editorEl.innerText.trim();
		if (!content && !this.pendingAtts.length) { new Notice('Write something first!'); return; }

		await this.ensureFolders();

		// Save attachments to vault first
		const savedAtts: MemoAttachment[] = [];
		for (const att of this.pendingAtts) {
			try {
				const saved = await this.saveAttachmentToVault(att);
				savedAtts.push(saved);
			} catch (e) {
				new Notice(`Failed to save attachment: ${att.name}`);
			}
		}

		const tags = this.extractTags(content);
		const md = this.buildMemoMarkdown(content, tags, savedAtts, true);
		const firstLine = content.split('\n')[0].trim();
		const baseName = this.sanitizeFilename(firstLine) || Date.now().toString();
		let filePath = `${MEMO_FOLDER}/${baseName}.md`;
		let counter = 1;
		while (this.vault.getAbstractFileByPath(filePath)) {
			filePath = `${MEMO_FOLDER}/${baseName} ${counter++}.md`;
		}
		await this.vault.create(filePath, md);

		this.editorEl.innerHTML = '';
		this.pendingAtts = [];
		this.composerAttsEl.empty();
		await this.refresh();
		new Notice('Memo saved!');
	}

	// ─── FEED ────────────────────────────────────────────────

	private async refresh(filter = '', dateFilter?: Date) {
		this.cachedMemos = await this.loadMemos();
		this.renderCalendar(this.cachedMemos);
		this.renderTags(this.cachedMemos);

		let memos = this.cachedMemos;
		if (filter) {
			const lf = filter.toLowerCase();
			memos = memos.filter(m => m.content.toLowerCase().includes(lf) || m.tags.some(t => `#${t}`.toLowerCase().includes(lf)));
		}
		if (dateFilter) {
			memos = memos.filter(m => {
				const d = new Date(m.createdAt);
				return d.getFullYear() === dateFilter.getFullYear() && d.getMonth() === dateFilter.getMonth() && d.getDate() === dateFilter.getDate();
			});
		}
		if (this.includedTags.size > 0) {
			memos = memos.filter(m => [...this.includedTags].every(t => m.tags.includes(t)));
		}
		if (this.excludedTags.size > 0) {
			memos = memos.filter(m => ![...this.excludedTags].some(t => m.tags.includes(t)));
		}

		this.feedEl.empty();
		if (!memos.length) {
			this.feedEl.createDiv({ cls: 'mm-empty', text: filter ? `No memos matching "${filter}"` : 'No memos yet — start writing above!' });
			return;
		}
		for (const memo of memos) this.renderCard(memo);
	}

	private renderCard(memo: Memo) {
		const card = this.feedEl.createDiv('mm-card');

		const header = card.createDiv('mm-card-header');
		header.createSpan({ cls: 'mm-card-time', text: this.relTime(memo.createdAt) });

		const moreWrap = header.createDiv('mm-more-wrap');
		const moreBtn = moreWrap.createEl('button', { cls: 'mm-more-btn' });
		moreBtn.innerHTML = SVG.dots;

		const cardMenu = moreWrap.createDiv('mm-card-menu');
		this.buildCardMenu(cardMenu, memo, card);

		moreBtn.onclick = (e) => { e.stopPropagation(); cardMenu.classList.toggle('is-open'); };
		const closeMenu = () => cardMenu.classList.remove('is-open');
		document.addEventListener('click', closeMenu);
		this.cleanups.push(() => document.removeEventListener('click', closeMenu));

		// Body
		const body = card.createDiv('mm-card-body');
		body.innerHTML = this.renderMd(memo.content);

		// Make checkboxes interactive (updates the .md file)
		body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => {
			cb.removeAttribute('disabled');
			cb.addEventListener('change', async () => {
				const labelText = cb.closest('label')?.querySelector('.mm-todo-text')?.textContent ?? '';
				const from = cb.checked ? `- [ ] ${labelText}` : `- [x] ${labelText}`;
				const to   = cb.checked ? `- [x] ${labelText}` : `- [ ] ${labelText}`;
				await this.patchMemoContent(memo, memo.content.replace(from, to));
			});
		});

		// Attachments
		if (memo.attachments.length) {
			const atts = card.createDiv('mm-card-atts');

			// Collect resolved image sources first (for lightbox navigation)
			const lbImages: { src: string; alt: string }[] = [];
			for (const att of memo.attachments) {
				if (att.type === 'image') {
					const src = this.getImgSrc(att.vaultPath);
					if (src) lbImages.push({ src, alt: att.name });
				}
			}

			for (const att of memo.attachments) {
				if (att.type === 'image') {
					const img = atts.createEl('img', { cls: 'mm-card-img' });
					const src = this.getImgSrc(att.vaultPath);
					if (src) {
						img.src = src;
						const idx = lbImages.findIndex(i => i.src === src);
						img.onclick = () => this.showLightbox(lbImages, idx);
					}
					img.alt = att.name;
				} else if (att.type === 'video') {
					const wrap = atts.createDiv('mm-card-video-wrap');
					const playEl = wrap.createDiv('mm-play-overlay');
					playEl.innerHTML = SVG.play;
					const src = this.getImgSrc(att.vaultPath);
					if (src) {
						wrap.onclick = () => this.showVideoPlayer(src, att.name);
						this.generateVideoThumbnail(src).then(thumb => {
							if (thumb) {
								const img = document.createElement('img');
								img.className = 'mm-card-img';
								img.src = thumb;
								img.alt = att.name;
								wrap.insertBefore(img, playEl);
							}
						});
					}
				} else {
					const chip = atts.createDiv('mm-card-file');
					chip.innerHTML = `${SVG.file} <span>${att.name}</span>`;
					chip.onclick = () => {
						const file = this.vault.getAbstractFileByPath(att.vaultPath);
						if (file instanceof TFile) this.plugin.app.workspace.openLinkText(att.vaultPath, '', true);
					};
				}
			}
		}
	}

	private buildCardMenu(menu: HTMLElement, memo: Memo, card: HTMLElement) {
		const openItem = menu.createDiv('mm-menu-item');
		openItem.innerHTML = `${SVG.file} Open file`;
		openItem.onclick = () => {
			const file = this.vault.getAbstractFileByPath(memo.filePath);
			if (file instanceof TFile) this.plugin.app.workspace.openLinkText(memo.filePath, '', true);
			menu.classList.remove('is-open');
		};

		const copyItem = menu.createDiv('mm-menu-item');
		copyItem.innerHTML = `${SVG.copy} Copy text`;
		copyItem.onclick = () => { navigator.clipboard.writeText(memo.content); new Notice('Copied!'); menu.classList.remove('is-open'); };

		const delItem = menu.createDiv({ cls: 'mm-menu-item mm-menu-danger' });
		delItem.innerHTML = `${SVG.trash} Delete`;
		delItem.onclick = async () => {
			const file = this.vault.getAbstractFileByPath(memo.filePath);
			if (file instanceof TFile) {
				// Also delete attachments stored in assets
				for (const att of memo.attachments) {
					const attFile = this.vault.getAbstractFileByPath(att.vaultPath);
					if (attFile instanceof TFile) await this.vault.delete(attFile);
				}
				await this.vault.delete(file);
			}
			card.remove();
			this.cachedMemos = this.cachedMemos.filter(m => m.filePath !== memo.filePath);
			this.renderTags(this.cachedMemos);
			this.renderCalendar(this.cachedMemos);
			if (!this.cachedMemos.length) this.feedEl.createDiv({ cls: 'mm-empty', text: 'No memos yet — start writing above!' });
		};
	}

	private startEdit(memo: Memo, card: HTMLElement) {
		card.empty();
		card.addClass('mm-card-editing');

		const ed = card.createDiv({ cls: 'mm-editor mm-edit-editor' });
		ed.contentEditable = 'true';
		ed.innerText = memo.content;
		setTimeout(() => ed.focus(), 0);

		const acts = card.createDiv('mm-edit-actions');
		acts.createEl('button', { cls: 'mm-btn-ghost', text: 'Cancel' }).onclick = () => this.refresh();
		const saveBtn = acts.createEl('button', { cls: 'mm-save-btn', text: 'Save' });
		saveBtn.onclick = async () => {
			const newContent = ed.innerText.trim();
			if (!newContent) return;
			await this.patchMemoContent(memo, newContent);
			await this.refresh();
		};
	}

	/** Update body content + tags + updatedAt in an existing .md file */
	private async patchMemoContent(memo: Memo, newContent: string) {
		const file = this.vault.getAbstractFileByPath(memo.filePath);
		if (!(file instanceof TFile)) return;
		const tags = this.extractTags(newContent);
		const md = this.buildMemoMarkdown(newContent, tags, memo.attachments, memo.isPrivate, new Date(memo.createdAt).toISOString());
		await this.vault.modify(file, md);
	}

	// ─── UTILS ───────────────────────────────────────────────

	private renderMd(raw: string): string {
		return raw
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
			.replace(/\*(.*?)\*/g, '<em>$1</em>')
			.replace(/`(.*?)`/g, '<code>$1</code>')
			.replace(/^- \[x\] (.+)$/gm, '<label class="mm-todo mm-done"><input type="checkbox" checked disabled><s class="mm-todo-text">$1</s></label>')
			.replace(/^- \[ \] (.+)$/gm, '<label class="mm-todo"><input type="checkbox" disabled><span class="mm-todo-text">$1</span></label>')
			.replace(/(^|\s)(#([\w฀-๿一-鿿-]+))/g, '$1<span class="mm-tag-inline">$2</span>')
			.replace(/\n/g, '<br>');
	}

	private extractTags(content: string): string[] {
		return [...new Set([...content.matchAll(/#([\w฀-๿一-鿿-]+)/g)].map(m => m[1]))];
	}

	private generateVideoThumbnail(src: string): Promise<string> {
		return new Promise((resolve) => {
			const video = document.createElement('video');
			video.muted = true;
			video.playsInline = true;
			video.preload = 'metadata';

			const cleanup = () => { video.src = ''; video.load(); };

			video.addEventListener('loadeddata', () => {
				video.currentTime = 0.001;
			}, { once: true });

			video.addEventListener('seeked', () => {
				try {
					const canvas = document.createElement('canvas');
					canvas.width  = video.videoWidth  || 320;
					canvas.height = video.videoHeight || 180;
					canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
					resolve(canvas.toDataURL('image/jpeg', 0.8));
				} catch {
					resolve('');
				} finally {
					cleanup();
				}
			}, { once: true });

			video.addEventListener('error', () => { resolve(''); cleanup(); }, { once: true });
			video.src = src;
			video.load();
		});
	}

	private showVideoPlayer(src: string, name: string) {
		const overlay = document.body.createDiv('mm-lb');

		const video = overlay.createEl('video', { cls: 'mm-lb-video' });
		video.src = src;
		video.controls = true;
		video.autoplay = true;
		video.onclick = (e) => e.stopPropagation();

		const closeBtn = overlay.createEl('button', { cls: 'mm-lb-close', text: '×' });

		const doClose = () => {
			video.pause();
			overlay.remove();
			document.removeEventListener('keydown', onKey);
		};

		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') doClose(); };
		closeBtn.onclick = (e) => { e.stopPropagation(); doClose(); };
		overlay.onclick = doClose;
		document.addEventListener('keydown', onKey);
	}

	private showLightbox(images: { src: string; alt: string }[], startIndex: number) {
		let current = startIndex;

		const overlay = document.body.createDiv('mm-lb');

		// Close button (top-right corner)
		const closeBtn = overlay.createEl('button', { cls: 'mm-lb-close', text: '×' });

		// Main image — clicks on it don't close the overlay
		const img = overlay.createEl('img', { cls: 'mm-lb-img' });
		img.onclick = (e) => e.stopPropagation();

		// "2 / 5" counter
		const counter = overlay.createDiv('mm-lb-counter');
		if (images.length <= 1) counter.style.display = 'none';

		const go = (idx: number) => {
			current = ((idx % images.length) + images.length) % images.length;
			img.src = images[current].src;
			img.alt = images[current].alt;
			counter.setText(`${current + 1} / ${images.length}`);
		};

		const doClose = () => {
			overlay.remove();
			document.removeEventListener('keydown', onKey);
		};

		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { doClose(); return; }
			if (images.length > 1) {
				if (e.key === 'ArrowLeft')  go(current - 1);
				if (e.key === 'ArrowRight') go(current + 1);
			}
		};

		closeBtn.onclick = (e) => { e.stopPropagation(); doClose(); };
		overlay.onclick = doClose;

		if (images.length > 1) {
			const prev = overlay.createEl('button', { cls: 'mm-lb-nav mm-lb-prev' });
			prev.innerHTML = SVG.chevronLeft;
			prev.onclick = (e) => { e.stopPropagation(); go(current - 1); };

			const next = overlay.createEl('button', { cls: 'mm-lb-nav mm-lb-next' });
			next.innerHTML = SVG.chevronRight;
			next.onclick = (e) => { e.stopPropagation(); go(current + 1); };
		}

		document.addEventListener('keydown', onKey);
		go(startIndex);
	}

	/** Read dragged vault files from Obsidian's internal drag manager. */
	private getVaultDragFiles(): TFile[] {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const draggable = (this.plugin.app as any).dragManager?.draggable;
		if (!draggable) return [];
		const files: TFile[] = [];
		if (draggable.file instanceof TFile) files.push(draggable.file);
		if (Array.isArray(draggable.files)) {
			for (const f of draggable.files) {
				if (f instanceof TFile) files.push(f);
			}
		}
		return files;
	}

	private sanitizeFilename(name: string): string {
		return name
			.replace(/[\\/:*?"<>|]/g, '')  // Windows/cross-platform invalid chars
			.replace(/^[.\s]+|[.\s]+$/g, '') // trim leading/trailing dots and spaces
			.slice(0, 80);                   // keep filename reasonably short
	}

	private relTime(ts: number): string {
		const d = Date.now() - ts;
		const s = Math.floor(d / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), day = Math.floor(h / 24);
		if (s < 60) return 'just now';
		if (m < 60) return `${m} minute${m !== 1 ? 's' : ''} ago`;
		if (h < 24) return `${h} hour${h !== 1 ? 's' : ''} ago`;
		if (day < 7) return `${day} day${day !== 1 ? 's' : ''} ago`;
		return new Date(ts).toLocaleDateString();
	}

	async onClose() {
		this.cleanups.forEach(fn => fn());
		this.cleanups = [];
	}
}

// ─── SVG ICONS ───────────────────────────────────────────────

const SVG = {
	search:      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
	chevronLeft: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>`,
	chevronRight:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`,
	tag:         `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
	checkbox:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
	paperclip:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
	link:        `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
	location:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
	lock:        `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
	dots:        `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`,
	edit:        `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
	copy:        `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
	trash:       `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
	file:        `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
	play:        `<svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><circle cx="12" cy="12" r="12" fill="rgba(0,0,0,0.45)"/><polygon points="10,8 18,12 10,16" fill="white"/></svg>`,
};
