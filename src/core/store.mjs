
import path from 'node:path';
import { readJson, atomicWriteJson } from './util.mjs';
import { dataDir } from './config.mjs';

/**
 * 带防抖落盘的 JSON 存储。所有模块的持久化都走它，避免并发写坏文件。
 */
export class JsonStore {
  constructor(fileName, initial) {
    this.file = path.isAbsolute(fileName) ? fileName : path.join(dataDir(), fileName);
    this.data = initial || {};
    this.timer = null;
    this.writing = Promise.resolve();
    this.dirty = false;
  }

  async load() {
    const raw = await readJson(this.file, null);
    if (raw && typeof raw === 'object') this.data = raw;
    return this.data;
  }

  markDirty() {
    this.dirty = true;
    if (this.timer) return;
    const self = this;
    this.timer = setTimeout(function () {
      self.timer = null;
      self.flush().catch(function () {});
    }, 400);
    if (this.timer.unref) this.timer.unref();
  }

  async flush() {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const snapshot = this.data;
    const self = this;
    this.writing = this.writing.then(function () {
      return atomicWriteJson(self.file, snapshot);
    });
    return this.writing;
  }
}
