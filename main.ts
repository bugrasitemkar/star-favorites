import {
	App,
	ItemView,
	Menu,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";

const FAVORITES_VIEW_TYPE = "star-favorites-view";
const FAV_CLASS = "fav-favorited";
const REFRESH_DEBOUNCE_MS = 60;

interface FavoritesData {
	favorites: string[];
}

const DEFAULT_DATA: FavoritesData = {
	favorites: [],
};

export default class FavoritesPlugin extends Plugin {
	data: FavoritesData;
	private explorerObservers: MutationObserver[] = [];
	private refreshTimeout: number | null = null;

	async onload() {
		await this.loadFavorites();

		this.registerView(
			FAVORITES_VIEW_TYPE,
			(leaf) => new FavoritesView(leaf, this)
		);

		this.addRibbonIcon("star", "Open star favorites", () => {
			this.activateFavoritesView();
		});

		this.addCommand({
			id: "open-favorites-view",
			name: "Open star favorites",
			callback: () => this.activateFavoritesView(),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				this.addFavoriteMenuItem(menu, file);
			})
		);

		this.registerEvent(
			this.app.workspace.on("files-menu", (menu, files) => {
				this.addBulkFavoriteMenuItems(menu, files);
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.handleRename(file, oldPath);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.handleDelete(file);
			})
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.attachExplorerObservers();
				this.scheduleDecorationRefresh();
			})
		);

		this.app.workspace.onLayoutReady(() => {
			this.attachExplorerObservers();
			this.scheduleDecorationRefresh();
		});
	}

	onunload() {
		for (const observer of this.explorerObservers) {
			observer.disconnect();
		}
		this.explorerObservers = [];
		if (this.refreshTimeout !== null) {
			window.clearTimeout(this.refreshTimeout);
		}
	}

	private async loadFavorites() {
		const stored = await this.loadData();
		this.data = Object.assign({}, DEFAULT_DATA, stored);
	}

	private async saveFavorites() {
		await this.saveData(this.data);
	}

	isFavorite(path: string): boolean {
		return this.data.favorites.includes(path);
	}

	async toggleFavorite(file: TAbstractFile) {
		if (this.isFavorite(file.path)) {
			this.data.favorites = this.data.favorites.filter(
				(p) => p !== file.path
			);
		} else {
			this.data.favorites.push(file.path);
		}
		await this.saveFavorites();
		this.scheduleDecorationRefresh();
		this.refreshFavoritesViews();
	}

	private addFavoriteMenuItem(menu: Menu, file: TAbstractFile) {
		const isFav = this.isFavorite(file.path);
		menu.addItem((item) => {
			item.setTitle(isFav ? "Remove from favorites" : "Add to favorites")
				.setIcon(isFav ? "star-off" : "star")
				.onClick(() => this.toggleFavorite(file));
		});
	}

	private addBulkFavoriteMenuItems(menu: Menu, files: TAbstractFile[]) {
		if (files.length === 0) return;
		const anyFavorited = files.some((f) => this.isFavorite(f.path));
		const anyNotFavorited = files.some((f) => !this.isFavorite(f.path));

		if (anyNotFavorited) {
			menu.addItem((item) => {
				item.setTitle("Add to favorites")
					.setIcon("star")
					.onClick(async () => {
						for (const file of files) {
							if (!this.isFavorite(file.path)) {
								this.data.favorites.push(file.path);
							}
						}
						await this.saveFavorites();
						this.scheduleDecorationRefresh();
						this.refreshFavoritesViews();
					});
			});
		}
		if (anyFavorited) {
			menu.addItem((item) => {
				item.setTitle("Remove from favorites")
					.setIcon("star-off")
					.onClick(async () => {
						const paths = new Set(files.map((f) => f.path));
						this.data.favorites = this.data.favorites.filter(
							(p) => !paths.has(p)
						);
						await this.saveFavorites();
						this.scheduleDecorationRefresh();
						this.refreshFavoritesViews();
					});
			});
		}
	}

	private async handleRename(file: TAbstractFile, oldPath: string) {
		let changed = false;
		this.data.favorites = this.data.favorites.map((p) => {
			if (p === oldPath) {
				changed = true;
				return file.path;
			}
			if (p.startsWith(oldPath + "/")) {
				changed = true;
				return file.path + p.slice(oldPath.length);
			}
			return p;
		});
		if (changed) {
			await this.saveFavorites();
			this.scheduleDecorationRefresh();
			this.refreshFavoritesViews();
		}
	}

	private async handleDelete(file: TAbstractFile) {
		const before = this.data.favorites.length;
		this.data.favorites = this.data.favorites.filter(
			(p) => p !== file.path && !p.startsWith(file.path + "/")
		);
		if (this.data.favorites.length !== before) {
			await this.saveFavorites();
			this.scheduleDecorationRefresh();
			this.refreshFavoritesViews();
		}
	}

	async pruneFavorites(stalePaths: string[]) {
		const stale = new Set(stalePaths);
		const before = this.data.favorites.length;
		this.data.favorites = this.data.favorites.filter((p) => !stale.has(p));
		if (this.data.favorites.length !== before) {
			await this.saveFavorites();
			this.scheduleDecorationRefresh();
		}
	}

	private refreshFavoritesViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(
			FAVORITES_VIEW_TYPE
		)) {
			const view = leaf.view;
			if (view instanceof FavoritesView) {
				view.render();
			}
		}
	}

	private attachExplorerObservers() {
		for (const observer of this.explorerObservers) {
			observer.disconnect();
		}
		this.explorerObservers = [];

		for (const leaf of this.app.workspace.getLeavesOfType(
			"file-explorer"
		)) {
			const containerEl = (leaf.view as { containerEl: HTMLElement })
				.containerEl;
			if (!containerEl) continue;
			const observer = new MutationObserver(() => {
				this.scheduleDecorationRefresh();
			});
			observer.observe(containerEl, {
				childList: true,
				subtree: true,
			});
			this.explorerObservers.push(observer);
		}
	}

	scheduleDecorationRefresh() {
		if (this.refreshTimeout !== null) {
			window.clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = window.setTimeout(() => {
			this.refreshTimeout = null;
			this.applyExplorerDecorations();
		}, REFRESH_DEBOUNCE_MS);
	}

	private applyExplorerDecorations() {
		for (const leaf of this.app.workspace.getLeavesOfType(
			"file-explorer"
		)) {
			const containerEl = (leaf.view as { containerEl: HTMLElement })
				.containerEl;
			if (!containerEl) continue;
			const pathEls = containerEl.querySelectorAll<HTMLElement>(
				"[data-path]"
			);
			pathEls.forEach((el) => {
				const path = el.dataset.path;
				if (!path) return;
				const titleEl = el.matches(".nav-file-title, .nav-folder-title")
					? el
					: el.querySelector<HTMLElement>(
							".nav-file-title, .nav-folder-title"
					  );
				if (!titleEl) return;
				if (this.isFavorite(path)) {
					titleEl.classList.add(FAV_CLASS);
				} else {
					titleEl.classList.remove(FAV_CLASS);
				}
			});
		}
	}

	async activateFavoritesView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(FAVORITES_VIEW_TYPE)[0];
		if (!leaf) {
			const newLeaf = workspace.getLeftLeaf(false);
			if (!newLeaf) return;
			leaf = newLeaf;
			await leaf.setViewState({
				type: FAVORITES_VIEW_TYPE,
				active: true,
			});
		}
		workspace.revealLeaf(leaf);
	}

	revealInExplorer(file: TAbstractFile) {
		try {
			const internalPlugins = (
				this.app as unknown as {
					internalPlugins: {
						getPluginById(id: string): {
							instance: {
								revealInFolder?: (f: TAbstractFile) => void;
							};
						} | null;
					};
				}
			).internalPlugins;
			const fileExplorer = internalPlugins.getPluginById("file-explorer");
			fileExplorer?.instance.revealInFolder?.(file);
		} catch (e) {
			// File explorer reveal is a best-effort convenience; ignore if unavailable.
		}
	}
}

class FavoritesView extends ItemView {
	plugin: FavoritesPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: FavoritesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return FAVORITES_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Star Favorites";
	}

	getIcon(): string {
		return "star";
	}

	async onOpen() {
		this.render();
	}

	render() {
		const container = this.contentEl;
		container.empty();
		container.addClass("fav-view-container");
		container.createEl("div", { text: "Star Favorites", cls: "fav-view-title" });

		const favorites = this.plugin.data.favorites.slice().sort((a, b) =>
			a.localeCompare(b)
		);

		if (favorites.length === 0) {
			container.createEl("div", {
				text: "No favorites yet. Right-click a note or folder and choose “Add to favorites”.",
				cls: "fav-empty",
			});
			return;
		}

		const listEl = container.createDiv({ cls: "fav-list" });
		const stalePaths: string[] = [];
		for (const path of favorites) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!file) {
				stalePaths.push(path);
				continue;
			}
			this.renderItem(listEl, file);
		}
		if (stalePaths.length > 0) {
			void this.plugin.pruneFavorites(stalePaths);
		}
	}

	private renderItem(listEl: HTMLElement, file: TAbstractFile) {
		const isFolder = file instanceof TFolder;
		const itemEl = listEl.createDiv({ cls: "fav-item" });

		const iconEl = itemEl.createSpan({ cls: "fav-item-icon" });
		setIcon(iconEl, isFolder ? "folder" : "file-text");

		itemEl.createSpan({ cls: "fav-item-name", text: file.name });

		itemEl.addEventListener("click", () => {
			this.openFavorite(file);
		});

		itemEl.addEventListener("contextmenu", (evt: MouseEvent) => {
			evt.preventDefault();
			const menu = new Menu();
			menu.addItem((item) => {
				item.setTitle("Remove from favorites")
					.setIcon("star-off")
					.onClick(async () => {
						await this.plugin.toggleFavorite(file);
					});
			});
			menu.showAtMouseEvent(evt);
		});
	}

	private openFavorite(file: TAbstractFile) {
		if (file instanceof TFile) {
			this.app.workspace.getLeaf(false).openFile(file);
		} else if (file instanceof TFolder) {
			this.plugin.revealInExplorer(file);
		}
	}
}
