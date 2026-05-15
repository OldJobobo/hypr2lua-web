import { convertText, exampleInput } from "./converter.js";

const input = document.querySelector("#input");
const output = document.querySelector("#output");
const notes = document.querySelector("#notes");
const statusText = document.querySelector("#statusText");
const uploadInput = document.querySelector("#uploadInput");
const uploadButton = document.querySelector("#uploadButton");
const copyButton = document.querySelector("#copyButton");
const downloadButton = document.querySelector("#downloadButton");
const clearButton = document.querySelector("#clearButton");
const exampleButton = document.querySelector("#exampleButton");
const convertButton = document.querySelector("#convertButton");

let currentLua = "";
let currentNotes = [];
let lastFileName = null;

function setStatus(message, tone = "neutral") {
  statusText.textContent = message;
  statusText.dataset.tone = tone;
}

function renderNotes(items) {
  notes.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No review notes.";
    empty.className = "note-ok";
    notes.append(empty);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    notes.append(li);
  });
}

function convert() {
  const source = lastFileName || null;
  const text = input.value;

  if (!text.trim()) {
    currentLua = "";
    currentNotes = [];
    output.textContent = "";
    renderNotes([]);
    setStatus("Waiting for input");
    copyButton.disabled = true;
    downloadButton.disabled = true;
    return;
  }

  const result = convertText(text, source);
  currentLua = result.lua;
  currentNotes = result.unknown;
  output.textContent = result.lua;
  renderNotes(result.unknown);
  copyButton.disabled = false;
  downloadButton.disabled = false;

  if (result.unknown.length > 0) {
    setStatus(`${result.unknown.length} review note${result.unknown.length === 1 ? "" : "s"}`, "warn");
  } else {
    setStatus("Converted", "ok");
  }
}

function downloadLua() {
  const blob = new Blob([currentLua], { type: "text/x-lua;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "hyprland.lua";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function copyLua() {
  try {
    await navigator.clipboard.writeText(currentLua);
    setStatus("Copied", "ok");
  } catch {
    setStatus("Clipboard unavailable", "warn");
  }
}

input.addEventListener("input", () => {
  lastFileName = null;
  convert();
});

convertButton.addEventListener("click", convert);

uploadButton.addEventListener("click", () => {
  uploadInput.click();
});

uploadInput.addEventListener("change", async () => {
  const file = uploadInput.files?.[0];
  if (!file) {
    return;
  }

  try {
    lastFileName = file.name;
    input.value = await file.text();
    convert();
  } catch {
    setStatus("Could not read file", "warn");
  } finally {
    uploadInput.value = "";
  }
});

copyButton.addEventListener("click", copyLua);
downloadButton.addEventListener("click", downloadLua);

clearButton.addEventListener("click", () => {
  input.value = "";
  lastFileName = null;
  convert();
  input.focus();
});

exampleButton.addEventListener("click", () => {
  input.value = exampleInput;
  lastFileName = "example-hyprland.conf";
  convert();
  input.focus();
});

convert();
