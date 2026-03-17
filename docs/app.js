import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs";

const DB_NAME = "pdf-viewer-pwa";
const DB_VERSION = 1;
const STORE_NAME = "session";
const SESSION_KEY = "open-tabs";
const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.6;
const ZOOM_STEP = 0.2;

const state = {
  tabs: [],
  activeTabId: null,
  intersectionObserver: null,
};

const elements = {
  fileInput: document.querySelector("#file-input"),
  tabStrip: document.querySelector("#tab-strip"),
  viewerPanel: document.querySelector("#viewer-panel"),
  pageStack: document.querySelector("#page-stack"),
  pageIndicator: document.querySelector("#page-indicator"),
  zoomIndicator: document.querySelector("#zoom-indicator"),
  prevPage: document.querySelector("#prev-page"),
  nextPage: document.querySelector("#next-page"),
  zoomIn: document.querySelector("#zoom-in"),
  zoomOut: document.querySelector("#zoom-out"),
  fitWidth: document.querySelector("#fit-width"),
  tabTemplate: document.querySelector("#tab-template"),
};

boot().catch((error) => {
  console.error(error);
  showGlobalError("初期化に失敗しました。ページを再読み込みしてください。");
});

async function boot() {
  bindEvents();
  await restoreSession();
  renderTabs();
  await renderActiveTab();
  await registerServiceWorker();
}

function bindEvents() {
  elements.fileInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (!files.length) {
      return;
    }

    await addFilesAsTabs(files);
  });

  elements.prevPage.addEventListener("click", () => stepPage(-1));
  elements.nextPage.addEventListener("click", () => stepPage(1));
  elements.zoomIn.addEventListener("click", () => adjustZoom(ZOOM_STEP));
  elements.zoomOut.addEventListener("click", () => adjustZoom(-ZOOM_STEP));
  elements.fitWidth.addEventListener("click", fitWidth);
  elements.pageStack.addEventListener("scroll", handleViewerScroll, { passive: true });
}

async function addFilesAsTabs(files) {
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const tab = {
      id: crypto.randomUUID(),
      name: file.name,
      lastModified: file.lastModified,
      size: file.size,
      buffer,
      zoom: DEFAULT_ZOOM,
      currentPage: 1,
      pageCount: 0,
      pdfDoc: null,
      renderedPages: new Set(),
    };

    await hydratePdf(tab);
    state.tabs.push(tab);
    state.activeTabId = tab.id;
  }

  await persistSession();
  renderTabs();
  await renderActiveTab();
}

async function hydratePdf(tab) {
  const loadingTask = pdfjsLib.getDocument({ data: tab.buffer.slice(0) });
  tab.pdfDoc = await loadingTask.promise;
  tab.pageCount = tab.pdfDoc.numPages;
}

function renderTabs() {
  elements.tabStrip.innerHTML = "";

  for (const tab of state.tabs) {
    const fragment = elements.tabTemplate.content.cloneNode(true);
    const root = fragment.querySelector(".tab");
    const activateButton = fragment.querySelector(".tab-activate");
    const closeButton = fragment.querySelector(".tab-close");

    root.dataset.tabId = tab.id;
    root.classList.toggle("is-active", tab.id === state.activeTabId);
    activateButton.textContent = tab.name;
    activateButton.title = tab.name;
    activateButton.addEventListener("click", async () => {
      state.activeTabId = tab.id;
      await persistSession();
      renderTabs();
      await renderActiveTab();
    });

    closeButton.addEventListener("click", async () => {
      await closeTab(tab.id);
    });

    elements.tabStrip.append(fragment);
  }
}

async function closeTab(tabId) {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) {
    return;
  }

  const [removed] = state.tabs.splice(index, 1);
  await removed.pdfDoc?.destroy();

  if (state.activeTabId === tabId) {
    state.activeTabId = state.tabs[Math.max(0, index - 1)]?.id ?? state.tabs[0]?.id ?? null;
  }

  await persistSession();
  renderTabs();
  await renderActiveTab();
}

function getActiveTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

async function renderActiveTab() {
  const activeTab = getActiveTab();

  if (!activeTab) {
    disconnectObserver();
    elements.pageStack.innerHTML = "";
    elements.pageStack.classList.add("is-empty");
    updateToolbar(null);
    return;
  }

  elements.pageStack.classList.remove("is-empty");
  updateToolbar(activeTab);
  elements.pageStack.innerHTML = "";
  activeTab.renderedPages = new Set();

  const fragment = document.createDocumentFragment();
  for (let pageNumber = 1; pageNumber <= activeTab.pageCount; pageNumber += 1) {
    fragment.append(createPageShell(pageNumber));
  }
  elements.pageStack.append(fragment);

  setupObserver(activeTab);
  await renderVisiblePages(activeTab);
  requestAnimationFrame(() => scrollToPage(activeTab.currentPage, false));
}

function createPageShell(pageNumber) {
  const shell = document.createElement("section");
  shell.className = "page-shell";
  shell.dataset.pageNumber = String(pageNumber);

  const card = document.createElement("article");
  card.className = "page-card";

  const surface = document.createElement("div");
  surface.className = "page-surface";
  surface.innerHTML = `<div class="page-placeholder">Loading page ${pageNumber}...</div>`;

  const label = document.createElement("div");
  label.className = "page-label";
  label.textContent = `Page ${pageNumber}`;

  card.append(surface, label);
  shell.append(card);
  return shell;
}

function setupObserver(tab) {
  disconnectObserver();

  state.intersectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const pageNumber = Number(entry.target.dataset.pageNumber);
          renderSinglePage(tab, pageNumber);
        }
      }
    },
    {
      root: elements.pageStack,
      rootMargin: "160px 0px",
      threshold: 0.05,
    },
  );

  elements.pageStack.querySelectorAll(".page-shell").forEach((node) => state.intersectionObserver.observe(node));
}

function disconnectObserver() {
  state.intersectionObserver?.disconnect();
  state.intersectionObserver = null;
}

async function renderVisiblePages(tab) {
  const firstPages = Array.from(elements.pageStack.querySelectorAll(".page-shell")).slice(0, 3);
  await Promise.all(firstPages.map((node) => renderSinglePage(tab, Number(node.dataset.pageNumber))));
}

async function renderSinglePage(tab, pageNumber) {
  if (tab.id !== state.activeTabId || tab.renderedPages.has(pageNumber)) {
    return;
  }

  tab.renderedPages.add(pageNumber);
  const shell = elements.pageStack.querySelector(`[data-page-number="${pageNumber}"] .page-surface`);
  if (!shell) {
    return;
  }

  try {
    const page = await tab.pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: tab.zoom * window.devicePixelRatio });
    const displayViewport = page.getViewport({ scale: tab.zoom });
    const canvas = document.createElement("canvas");
    canvas.className = "page-canvas";
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.aspectRatio = `${displayViewport.width} / ${displayViewport.height}`;

    const context = canvas.getContext("2d", { alpha: false });
    await page.render({
      canvasContext: context,
      viewport,
      transform: [1, 0, 0, 1, 0, 0],
    }).promise;

    shell.innerHTML = "";
    shell.append(canvas);
    shell.parentElement.style.setProperty("--page-width", `${displayViewport.width}px`);
  } catch (error) {
    console.error(error);
    shell.innerHTML = `<div class="error-note">Page ${pageNumber} could not be rendered.</div>`;
  }
}

async function adjustZoom(delta) {
  const activeTab = getActiveTab();
  if (!activeTab) {
    return;
  }

  activeTab.zoom = clamp(activeTab.zoom + delta, MIN_ZOOM, MAX_ZOOM);
  await rerenderActiveTab();
}

async function fitWidth() {
  const activeTab = getActiveTab();
  if (!activeTab) {
    return;
  }

  const firstPage = await activeTab.pdfDoc.getPage(1);
  const viewport = firstPage.getViewport({ scale: 1 });
  const containerWidth = Math.max(elements.pageStack.clientWidth - 20, 280);
  activeTab.zoom = clamp(containerWidth / viewport.width, MIN_ZOOM, MAX_ZOOM);
  await rerenderActiveTab();
}

async function rerenderActiveTab() {
  const activeTab = getActiveTab();
  if (!activeTab) {
    return;
  }

  const currentPage = activeTab.currentPage;
  await persistSession();
  await renderActiveTab();
  scrollToPage(currentPage, false);
}

function handleViewerScroll() {
  const activeTab = getActiveTab();
  if (!activeTab) {
    return;
  }

  let closestPage = activeTab.currentPage;
  let smallestDistance = Number.POSITIVE_INFINITY;

  elements.pageStack.querySelectorAll(".page-shell").forEach((node) => {
    const rect = node.getBoundingClientRect();
    const distance = Math.abs(rect.top - 84);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      closestPage = Number(node.dataset.pageNumber);
    }
  });

  if (closestPage !== activeTab.currentPage) {
    activeTab.currentPage = closestPage;
    updateToolbar(activeTab);
    persistSession();
  }
}

function stepPage(delta) {
  const activeTab = getActiveTab();
  if (!activeTab) {
    return;
  }

  const targetPage = clamp(activeTab.currentPage + delta, 1, activeTab.pageCount);
  activeTab.currentPage = targetPage;
  updateToolbar(activeTab);
  persistSession();
  scrollToPage(targetPage, true);
}

function scrollToPage(pageNumber, smooth) {
  const target = elements.pageStack.querySelector(`[data-page-number="${pageNumber}"]`);
  if (!target) {
    return;
  }

  target.scrollIntoView({
    behavior: smooth ? "smooth" : "auto",
    block: "start",
  });
}

function updateToolbar(activeTab) {
  if (!activeTab) {
    elements.pageIndicator.textContent = "0 / 0";
    elements.zoomIndicator.textContent = "100%";
    setToolbarDisabled(true);
    return;
  }

  elements.pageIndicator.textContent = `${activeTab.currentPage} / ${activeTab.pageCount}`;
  elements.zoomIndicator.textContent = `${Math.round(activeTab.zoom * 100)}%`;
  setToolbarDisabled(false);
}

function setToolbarDisabled(disabled) {
  [
    elements.prevPage,
    elements.nextPage,
    elements.zoomIn,
    elements.zoomOut,
    elements.fitWidth,
  ].forEach((button) => {
    button.disabled = disabled;
  });
}

async function restoreSession() {
  const session = await loadSession();
  if (!session?.tabs?.length) {
    return;
  }

  for (const persistedTab of session.tabs) {
    const tab = {
      ...persistedTab,
      pdfDoc: null,
      renderedPages: new Set(),
    };

    await hydratePdf(tab);
    state.tabs.push(tab);
  }

  state.activeTabId = session.activeTabId && state.tabs.some((tab) => tab.id === session.activeTabId)
    ? session.activeTabId
    : state.tabs[0]?.id ?? null;
}

async function persistSession() {
  const payload = {
    activeTabId: state.activeTabId,
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      lastModified: tab.lastModified,
      size: tab.size,
      buffer: tab.buffer,
      zoom: tab.zoom,
      currentPage: tab.currentPage,
    })),
  };

  await saveSession(payload);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadSession() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(SESSION_KEY);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function saveSession(payload) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(payload, SESSION_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.error("Service worker registration failed", error);
  }
}

function showGlobalError(message) {
  elements.pageStack.innerHTML = `<div class="error-note">${message}</div>`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
