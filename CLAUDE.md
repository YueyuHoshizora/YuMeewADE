# CLAUDE.md

本倉庫的撰寫規範只有一份真值來源：**[AGENTS.md](AGENTS.md)**。請先讀完它再動手。

摘要：全案 TypeScript＋Node.js v24＋Electron；台帳為 Markdown／JSONL 檔案（不得引入資料庫）；外部 `claude`／`codex` CLI 一律經 `CliProvider` adapter；後端只監聽 127.0.0.1；安全規則 11 條逐條列於 AGENTS.md 第六節，為硬規則。
