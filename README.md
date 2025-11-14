# Realtime Multilingual Transcription & Meeting Assistant

Server: `server_20251114_130333_v11.js` (v1.9.0)  
Frontend: `index_20251114_134705_v2.html`  

Webブラウザのマイク入力を**連続録音**し、約 10 秒ごとにチャンクとしてサーバへ送信しながら、

- 左: **Raw Transcription**（ASR 出力そのまま）  
- 中央: **Translation**（gpt-5-nano による翻訳・校正）  
- 右: **Recap**（一定間隔でのリアルタイム議事録サマリ）  

を表示するシステムです。Windows 11 上の Node.js サーバーを前提とし、PC / iPad のブラウザから利用します。

---

## 1. アーキテクチャ概要

### 1.1 コンポーネント

- **Node.js サーバー**
  - ファイル: `server_20251114_130333_v11.js`
  - ライブラリ: `express`, `cors`, `dotenv`
  - 役割:
    - フロントエンド配信（`/` → `public/index.html`）
    - セッション初期化: `GET /session`
    - 音声チャンク書き起こし: `POST /transcribe-chunk`
    - Recap 生成: `POST /recap`
    - ヘルスチェック: `GET /health`

- **フロントエンド (ブラウザ)**
  - ファイル: `public/index.html`（`index_20251114_134705_v2.html` ベース）
  - 技術: Web Audio API, Fetch API
  - 役割:
    - マイクからの連続録音（約 10 秒ごとに WAV チャンク化）
    - Base64 data URL としてサーバーへ送信
    - Raw / Translation / Recap の UI 表示・オートスクロール
    - Lang セレクタ（訳＆Recap 共通）、フォントサイズ、Recap 自動実行の制御

- **OpenAI API**
  - ASR（音声→テキスト）
    - プライマリ: `gpt-4o-mini-transcribe`
    - フォールバック: `gpt-4o-transcribe`
  - 翻訳・校正: `gpt-5-nano`（Responses API）
  - Recap: `gpt-5-nano`（Responses API）

### 1.2 フロー（音声→テキスト→翻訳→Recap）

1. ブラウザでマイク録音開始。PCM をバッファリング。
2. 約 10 秒ごとに WAV にまとめ、Base64 文字列（data URL）へ変換。
3. `POST /transcribe-chunk` に以下を送信:
   - `sessionId` / `chunkId`
   - `audioBase64` / `mimeType`
   - `languageHint` / `targetLang` / `domainHints`
4. サーバー側処理:
   - `transcribeWithFallback()`
     - `gpt-4o-mini-transcribe` → 失敗時のみ `gpt-4o-transcribe` にフォールバック。
   - `translateToTarget()`
     - `gpt-5-nano`（Responses API）で翻訳。
     - `reasoning.effort = "minimal"` / `text.verbosity = "low"` を指定し、
       - 「訳文のみ」
       - 「解説・ローマ字・代案・meta commentary 禁止」
       を system プロンプトで明示。
     - 出力が空 or エラー時は同一モデルで 1 回だけ再試行。
   - 1 チャンクを `segment` としてメモリ上のセッションに蓄積。
5. ブラウザ表示:
   - 左ペイン: Raw Transcription を追記。
   - 中央ペイン: 翻訳テキストを追記（自動スクロール）。
6. Recap:
   - Recap ボタン ON で 30 秒ごとに `POST /recap` を自動実行。
   - サーバーは `segment.sourceText` を連結（最大 `RECAP_MAX_CHARS` 文字）し、
     `gpt-5-nano` でサマリ＋箇条書き議事録を生成 → 右ペインに反映。

---

## 2. セットアップ（Windows 11 + Node.js）

### 2.1 前提環境

- OS: Windows 11
- Node.js: v18 以上（推奨 v22）
- PowerShell 7 以降（任意）

Node バージョン確認:

```powershell
node -v
```

### 2.2 ディレクトリ構成例

```text
C:\dev\realtime_translate
  ├─ server_20251114_130333_v11.js
  ├─ .env
  ├─ package.json
  └─ public
      └─ index.html   （index_20251114_134705_v2.html をコピー）
```

### 2.3 初期化手順

```powershell
mkdir C:\dev\realtime_translate
cd C:\dev\realtime_translate

npm init -y
npm install express cors dotenv
```

`package.json` の例:

```jsonc
{
  "name": "realtime-translate",
  "version": "1.0.0",
  "main": "server_20251114_130333_v11.js",
  "scripts": {
    "start": "node ./server_20251114_130333_v11.js"
  }
}
```

`public` フォルダを作成し、`index_20251114_134705_v2.html` を `public/index.html` として保存。

---

## 3. .env 設定

`.env` のテンプレート例:

```dotenv
OPENAI_API_KEY=sk-...   # 自身のキー

PORT=3000

# Realtime API（UI ステータス表示用 / 将来拡張）
REALTIME_MODEL=gpt-realtime-mini
REALTIME_VOICE=alloy

# ASR
TRANSCRIBE_PRIMARY_MODEL=gpt-4o-mini-transcribe
TRANSCRIBE_FALLBACK_MODEL=gpt-4o-transcribe
TRANSCRIBE_LANGUAGE=auto   # auto = 言語自動判定

# 翻訳・校正
EN_SEGMENT_MODEL=gpt-5-nano

# Recap
RECAP_MODEL=gpt-5-nano
RECAP_FALLBACK_MODEL=gpt-5-nano
RECAP_MAX_CHARS=4000

# 翻訳 & Recap のデフォルト出力言語
# en / ja / zh / fr / es
OUTPUT_LANG=en
```

> ※ チャンク長（10 秒）は現状 `index.html` 内の `samplesPerChunk` で制御。  
> 今後 `.env` から制御できるように拡張予定。

---

## 4. 起動と利用方法

### 4.1 サーバー起動

```powershell
cd C:\dev\realtime_translate
node .\server_20251114_130333_v11.js
```

ログ例:

```text
[dotenv@17.2.3] injecting env (xx) from .env
[server] Listening on http://localhost:3000
[server] Meta: { file: 'server_20251114_130333_v11.js',
  version: 'v1.9.0',
  builtAt: '2025-11-14T13:03:33+09:00' }
```

### 4.2 ブラウザからアクセス

1. PC / iPad のブラウザで `http://localhost:3000` を開く。
2. ステータスが `Server: ready (...)` になっていることを確認。
3. 操作概要:
   - `Mic` ボタン: マイク使用の ON/OFF
   - `Start` / `Stop`: 録音開始・停止
   - `Transcribe`: 書き起こし処理の ON/OFF
   - `Lang`: 翻訳＆Recap のターゲット言語（EN / JP / CN / FR / ES）
   - `Font`: フォントサイズ調整
   - `Recap`: 自動 Recap の ON/OFF（ON のとき 30 秒ごとに `/recap` 実行）

---

## 5. エンドポイント仕様

### 5.1 `GET /session`

- 用途: フロント初期化・`sessionId` 取得。
- レスポンス例（抜粋）:

```jsonc
{
  "ok": true,
  "sessionId": "sess_xxx",
  "transcription": {
    "model": "gpt-4o-mini-transcribe",
    "fallback_model": "gpt-4o-transcribe",
    "language": "auto"
  },
  "translation": {
    "model": "gpt-5-nano",
    "default_output_lang": "en"
  },
  "recap": {
    "model": "gpt-5-nano",
    "fallback_model": "gpt-5-nano",
    "max_chars": 4000
  },
  "realtime": {
    "model": "gpt-realtime-mini",
    "voice": "alloy"
  },
  "server": {
    "file": "server_20251114_130333_v11.js",
    "version": "v1.9.0",
    "builtAt": "..."
  }
}
```

### 5.2 `POST /transcribe-chunk`

- リクエスト body:

```jsonc
{
  "sessionId": "sess_xxx",
  "chunkId": 1,
  "audioBase64": "data:audio/wav;base64,...",
  "mimeType": "audio/wav",
  "isLast": false,
  "languageHint": "auto",
  "domainHints": ["business", "deep-tech"],
  "targetLang": "en"
}
```

- 正常レスポンス:

```jsonc
{
  "ok": true,
  "sessionId": "sess_xxx",
  "segment": {
    "id": "seg_xxx",
    "chunkId": 1,
    "sourceText": "ASRのテキスト...",
    "translatedText": "Translated sentence...",
    "outputLang": "en",
    "createdAt": "2025-11-14T..."
  },
  "meta": {
    "isLast": false,
    "asrModel": "gpt-4o-mini-transcribe",
    "asrLanguage": "auto",
    "targetLang": "en",
    "targetLangName": "English"
  }
}
```

- エラー例:

```jsonc
{
  "ok": false,
  "error": "Internal error in /transcribe-chunk",
  "detail": "Transcription failed with status 500 ...",
  "model": "gpt-4o-transcribe",
  "fallbackTried": true,
  "status": 500,
  "upstream": {
    "status": 500,
    "bodySnippet": "{...OpenAI error body...}"
  },
  "requestInfo": {
    "chunkId": 1,
    "targetLang": "en",
    "mimeType": "audio/wav",
    "hasAudioBase64": true,
    "audioBase64Prefix": "data:audio/wav;base64,..."
  }
}
```

### 5.3 `POST /recap`

- リクエスト body:

```jsonc
{
  "sessionId": "sess_xxx",
  "domainHints": ["business", "deep-tech"],
  "targetLang": "en"
}
```

- 正常レスポンス:

```jsonc
{
  "ok": true,
  "sessionId": "sess_xxx",
  "recap": {
    "text": "Summary...\n\n- point 1\n- point 2",
    "model": "gpt-5-nano",
    "outputLang": "en",
    "createdAt": "2025-11-14T..."
  }
}
```

---

## 6. トラブルシューティング

### 6.1 `Cannot GET /`

- 原因例:
  - `public/index.html` が存在しない
  - サーバー起動ディレクトリが誤り
- 対応:
  - `C:\dev\realtime_translate\public\index.html` の存在確認
  - 起動時にプロジェクトルートへ `cd` しているか確認

### 6.2 `[ERROR] Transcribe failed` / 500 エラー

- PowerShell で `/transcribe-chunk ERROR` ログと `upstream.bodySnippet` を確認。
- 典型的原因:
  - `OPENAI_API_KEY` 未設定 / 間違い
  - モデル名 typo
  - ネットワーク / FW / プロキシの制限
- 対処:
  - `gpt-4o-mini-transcribe` / `gpt-4o-transcribe` / `gpt-5-nano` への疎通テストスクリプトで確認。

### 6.3 翻訳に解説・ローマ字が混じる

- 本バージョンでは:
  - `reasoning.effort = "minimal"`
  - `text.verbosity = "low"`
  - 「訳文のみ。解説禁止。」を system プロンプトで指定。
- それでも残る場合:
  - `domainHints` をより明確にする（例: `["pharma", "regulation"]`）。
  - 追加で「Do not show analysis or alternatives. Output only the final translation.」などをプロンプト末尾に付与。

### 6.4 Recap が表示されない

- ブラウザの Network タブで `/recap` が送信されているか確認。
  - 送信されていない → Recap ボタンが OFF / フロント JS の問題。
  - 送信されているが 500 → サーバーログ `/recap ERROR` と `upstream.bodySnippet` を確認。

### 6.5 Node プロセスが残る / ポート競合

```powershell
Get-Process node
Stop-Process -Name node -Force
```

---

## 7. 今後の拡張

- `.env` からチャンク長（秒数）を制御し、フロントとサーバーで共有。
- glossary（専門用語辞書）の外部ファイルを読み込み、system プロンプトに自動注入。
- GCP / Cloud Run などへのデプロイ用セットアップスクリプト追加。
- Speaker diarization を追加し、話者タグを付加した議事録表示。
