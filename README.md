# file-service

Dịch vụ upload file dùng chung cho 3 web: **blog**, **cellphones**, **job-portal**. File được lưu trên Cloudflare R2. Service **không giữ file đi qua nó**: nó chỉ cấp link upload tạm (presigned URL), rồi trình duyệt/ứng dụng upload thẳng lên R2.

- [Cách hoạt động](#1-cách-hoạt-động)
- [Xác thực](#2-xác-thực-api-key)
- [Quy tắc từng app](#3-quy-tắc-từng-app-và-context)
- [Gọi API](#4-gọi-api) (presign, confirm, xoá, đọc file private)
- [Ví dụ trọn luồng](#5-ví-dụ-trọn-luồng)
- [Lỗi thường gặp](#6-lỗi-và-cách-xử-lý)
- [Cấu hình và chạy](#7-cấu-hình-và-chạy) / [Triển khai](#8-triển-khai-lên-server)
- [Test API](#9-test-api)

---

## 1. Cách hoạt động

Mọi upload đều đi qua 3 bước. File luôn vào thư mục `temp/` trước, chỉ khi bạn **confirm** nó mới được chuyển sang vị trí chính thức.

```
Web (backend)                  file-service                       Cloudflare R2
     │  1. POST /presign  ───────►  kiểm tra luật, ký URL
     │  ◄──── tempKey + uploadUrl ─┘
     │
Web (trình duyệt)
     │  2. PUT uploadUrl (gửi file) ───────────────────────────────►  temp/...
     │
Web (backend)
     │  3. POST /confirm  ───────►  copy temp/... → public|private/...
     │  ◄──── key (+ url nếu public)
```

Hai loại file, nằm ở **hai bucket riêng**:

| Loại | Bucket | Cách xem file |
|---|---|---|
| `public` (ảnh bài viết, avatar, logo...) | bucket public | Mở thẳng `url` trả về từ confirm |
| `private` (CV ứng viên) | bucket private, **không bật public** | Chỉ xem được qua link tạm do `POST /read-url` cấp |

Đường dẫn file trong bucket:

```
temp/{public|private}/{app}/{context}/{YYYY-MM}/{uuid}.{đuôi}     ← sau presign, trước confirm
{public|private}/{app}/{context}/{YYYY-MM}/{uuid}.{đuôi}          ← sau confirm
```

## 2. Xác thực (API key)

Mọi endpoint dưới `/api/v1/files` cần header `x-api-key`. **Mỗi web có một key riêng**, service dựa vào key để biết web nào đang gọi. Vì vậy body request **không có** trường `app`, và một web không thể thao tác trên file của web khác.

| Web | Biến môi trường chứa key |
|---|---|
| blog | `API_KEY_BLOG` |
| cellphones | `API_KEY_CELLPHONES` |
| job-portal | `API_KEY_JOB_PORTAL` |

```
x-api-key: <key của web bạn>
```

> **Quan trọng:** API key chỉ để trong **backend** của từng web. Không đưa vào code chạy ở trình duyệt hay app mobile. Cách đúng: backend của web gọi `presign`/`confirm`, sau đó chỉ gửi `uploadUrl` cho trình duyệt.

`GET /health` không cần key.

## 3. Quy tắc từng app và context

Mỗi lần gọi `presign` phải chỉ rõ `context` (mục đích upload). Mỗi context có luật riêng:

| App | `context` | Loại | MIME được phép | Tối đa / file | Tối đa file / lần |
|---|---|---|---|---|---|
| blog | `post-image` | public | jpeg, png, webp, gif | 5 MB | 10 |
| blog | `avatar` | public | jpeg, png, webp | 2 MB | 1 |
| cellphones | `product-gallery` | public | jpeg, png, webp | 2 MB | 8 |
| job-portal | `company-logo` | public | jpeg, png, webp | 2 MB | 1 |
| job-portal | `candidate-cv` | **private** | pdf, doc, docx | 10 MB | 1 |

Dùng context của app khác (ví dụ blog dùng `candidate-cv`) sẽ bị từ chối. Luật nằm ở `src/config/app-policies.ts`.

## 4. Gọi API

Base URL: `https://<domain-của-bạn>/api/v1/files` (khi chạy local: `http://localhost:4000/api/v1/files`).
Tất cả request là `POST`/`DELETE` với `Content-Type: application/json`, trừ khi ghi khác.

Mọi response thành công có dạng `{ "success": true, "data": ... }`. Lỗi có dạng `{ "success": false, "message": "..." }`.

### 4.1. Lấy link upload — 1 file

`POST /presign`

```json
{
  "context": "post-image",
  "file": { "fileName": "anh-bia.png", "mimeType": "image/png", "size": 183204 }
}
```

- `size` là **số byte thật** của file. Nó được ký vào link, nên upload file có dung lượng khác sẽ bị R2 từ chối (xem [mục 6](#6-lỗi-và-cách-xử-lý)).
- `mimeType` phải nằm trong danh sách cho phép của context.

Response `200`:

```json
{
  "success": true,
  "data": {
    "originalName": "anh-bia.png",
    "tempKey": "temp/public/blog/post-image/2026-10/3f1c...e9.png",
    "uploadUrl": "https://<bucket>.<account>.r2.cloudflarestorage.com/temp/...?X-Amz-Algorithm=...",
    "expiresIn": 600,
    "previewUrl": "https://pub-xxxx.r2.dev/temp/public/blog/post-image/2026-10/3f1c...e9.png"
  }
}
```

Link `uploadUrl` sống **600 giây (10 phút)**. Giữ lại `tempKey` để confirm.

`previewUrl` (chỉ có với file public, file private là `null`) xem được ngay sau khi upload, dùng để hiển thị xem trước. Đây vẫn là bản tạm trong `temp/`: phải confirm mới có URL bền, không lưu `previewUrl` vào database.

### 4.2. Upload file lên R2

Gọi **thẳng** `uploadUrl` bằng `PUT`, body là nội dung file. **Không** gửi `x-api-key` ở bước này.

```bash
curl -X PUT "$UPLOAD_URL" -H "Content-Type: image/png" --data-binary @anh-bia.png
```

Thành công khi R2 trả `200` (body rỗng).

### 4.3. Lấy link upload — nhiều file

`POST /presign-batch` (tối đa số file theo bảng ở mục 3)

```json
{
  "context": "post-image",
  "files": [
    { "fileName": "1.png", "mimeType": "image/png", "size": 1000 },
    { "fileName": "2.jpg", "mimeType": "image/jpeg", "size": 2000 }
  ]
}
```

`data` là **mảng** các phần tử giống 4.1, đúng thứ tự gửi lên. PUT từng file vào `uploadUrl` tương ứng.

### 4.4. Xác nhận file (chuyển từ temp sang chính thức)

`POST /confirm`

```json
{ "tempKey": "temp/public/blog/post-image/2026-10/3f1c...e9.png" }
```

- Confirm chỉ **copy** file sang vị trí chính thức, **không xoá** bản tạm trong `temp/`. Bản tạm được dọn bằng lifecycle rule của bucket (xem [mục 7](#bucket-và-quy-tắc-dọn-temp)); cần xoá sớm thì gọi xoá với chính `tempKey` (mục 4.6).

File **public**:

```json
{ "success": true, "data": {
  "key": "public/blog/post-image/2026-10/3f1c...e9.png",
  "visibility": "public",
  "url": "https://pub-xxxx.r2.dev/public/blog/post-image/2026-10/3f1c...e9.png"
} }
```

File **private** (`url` luôn `null`):

```json
{ "success": true, "data": {
  "key": "private/job-portal/candidate-cv/2026-10/a18f...44.pdf",
  "visibility": "private",
  "url": null
} }
```

**Lưu `key` vào database của web bạn** (và `url` với file public). Bạn cần `key` để xoá hoặc đọc file sau này.

`POST /confirm-batch` — body `{ "tempKeys": ["...", "..."] }`, `data` là mảng kết quả như trên.

> Không confirm thì file chỉ nằm ở `temp/`. Hãy confirm sau khi người dùng lưu form/bài viết thành công.

### 4.5. Đọc file private (link tạm)

`POST /read-url`

```json
{ "key": "private/job-portal/candidate-cv/2026-10/a18f...44.pdf", "downloadFileName": "Nguyen Van A.pdf" }
```

`downloadFileName` là tuỳ chọn, đặt tên file khi trình duyệt tải về (hỗ trợ dấu cách và tiếng Việt).

```json
{ "success": true, "data": {
  "key": "private/job-portal/candidate-cv/2026-10/a18f...44.pdf",
  "readUrl": "https://<bucket-private>.<account>.r2.cloudflarestorage.com/private/...?X-Amz-...",
  "expiresIn": 900
} }
```

`readUrl` sống **900 giây (15 phút)** và chỉ dùng được với `GET`. Hãy tạo link mới mỗi lần người dùng cần xem, không lưu link vào database.

### 4.6. Xoá file

Xoá 1 file — `DELETE /api/v1/files`:

```json
{ "key": "public/blog/post-image/2026-10/3f1c...e9.png" }
```

Xoá nhiều file — `POST /delete-batch` (tối đa 1000 key):

```json
{ "keys": ["public/blog/post-image/2026-10/a.png", "public/blog/post-image/2026-10/b.png"] }
```

```json
{ "success": true, "data": { "deletedCount": 2, "keys": ["...", "..."] } }
```

- Chỉ xoá được file **của app mình** (key phải bắt đầu bằng `public/`, `private/` hoặc `temp/...` rồi đến tên app của bạn). Nếu có một key sai app, **cả batch bị từ chối**, không xoá gì.
- Xoá key không tồn tại vẫn tính là thành công (R2 xoá theo kiểu idempotent). Key trùng được loại bớt.
- Nếu R2 từ chối một số key, response có thêm `data.failed: [{ key, code, message }]`.

### 4.7. Tóm tắt endpoint

| Method | Đường dẫn | Việc |
|---|---|---|
| GET | `/` hoặc `/health` | Kiểm tra service còn sống (không cần key) |
| POST | `/api/v1/files/presign` | Link upload cho 1 file |
| POST | `/api/v1/files/presign-batch` | Link upload cho nhiều file |
| POST | `/api/v1/files/confirm` | Xác nhận 1 file |
| POST | `/api/v1/files/confirm-batch` | Xác nhận nhiều file |
| DELETE | `/api/v1/files` | Xoá 1 file (key trong body) |
| POST | `/api/v1/files/delete-batch` | Xoá nhiều file |
| POST | `/api/v1/files/read-url` | Link đọc file private |

## 5. Ví dụ trọn luồng

### 5.1. Bằng curl (ảnh bài viết của blog)

```bash
BASE=http://localhost:4000/api/v1/files
KEY=<API_KEY_BLOG>

# 1. Xin link upload
curl -s -X POST "$BASE/presign" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"context":"post-image","file":{"fileName":"a.png","mimeType":"image/png","size":70}}'
# → lấy data.tempKey và data.uploadUrl

# 2. Upload file (size của file phải đúng 70 byte như đã khai báo)
curl -X PUT "<uploadUrl>" -H "Content-Type: image/png" --data-binary @a.png

# 3. Confirm
curl -s -X POST "$BASE/confirm" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"tempKey":"<tempKey>"}'
# → lấy data.key và data.url, lưu vào database
```

### 5.2. Bằng JavaScript

**Backend của web** (Node, giữ API key) cung cấp hai hàm gọi file-service:

```js
const BASE = process.env.FILE_SERVICE_URL + '/api/v1/files';
const headers = { 'x-api-key': process.env.FILE_SERVICE_KEY, 'Content-Type': 'application/json' };

async function call(path, body, method = 'POST') {
  const res = await fetch(BASE + path, { method, headers, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message);
  return json.data;
}

// Bước 1: backend trả { tempKey, uploadUrl } cho trình duyệt
exports.presign = (context, file) => call('/presign', { context, file });

// Bước 3: sau khi trình duyệt upload xong và người dùng lưu form
exports.confirm = (tempKey) => call('/confirm', { tempKey });
```

**Trình duyệt** chỉ upload file lên link mà backend đưa:

```js
// file: đối tượng File từ <input type="file">
const { tempKey, uploadUrl } = await (await fetch('/api/uploads/presign', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ context: 'post-image', file: { fileName: file.name, mimeType: file.type, size: file.size } }),
})).json();

const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
if (!put.ok) throw new Error('Upload lỗi: ' + put.status);

// rồi gửi tempKey cùng form lên backend để backend gọi confirm
```

Dùng `file.size` làm `size` trong presign là cách chắc chắn nhất để khớp dung lượng.

### 5.3. File private (CV)

```text
presign (context "candidate-cv") → PUT file → confirm → lưu "key" vào DB
Khi cần xem:  POST /read-url { key }  → mở readUrl trong vòng 15 phút
```

## 6. Lỗi và cách xử lý

| HTTP | Khi nào | Ví dụ `message` |
|---|---|---|
| 401 | Thiếu hoặc sai `x-api-key` | `Unauthorized: Invalid or missing x-api-key header` |
| 400 | Body sai hình dạng | `Invalid request: file.size: Number must be greater than 0` (kèm mảng `issues[{field, message}]`) |
| 400 | Vi phạm luật context | `File "a.pdf" has invalid MIME type ...`, `... exceeds limit ...`, `Batch size (11) exceeds max allowed (10) ...`, `Invalid context "x" for app "blog"` |
| 400 | Thao tác trên file của app khác | `Access denied: App "blog" cannot delete file "..."` |
| 400 | Key không hợp lệ | `Invalid key "..."` (có `..`, `//`, `\`...) |
| 400 | Confirm file chưa được upload | `The specified key does not exist.` |

Lỗi khi **PUT lên R2** (bước 2) do R2 trả về, không phải do file-service:

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| `403 SignatureDoesNotMatch` | Dung lượng file thật **khác** `size` đã khai báo ở presign. Đây là nguyên nhân phổ biến nhất. Khai báo đúng `file.size` rồi xin link mới |
| `403` sau khi để link quá lâu | Link đã quá 10 phút. Xin link mới |
| Lỗi CORS trong trình duyệt | Bucket chưa cấu hình CORS (xem mục 7) |

Mỗi link `uploadUrl` chỉ dùng cho đúng file đã khai báo; muốn upload lại thì gọi `presign` lại.

## 7. Cấu hình và chạy

Sao chép `.env.example` thành `.env` rồi điền giá trị:

| Biến | Ý nghĩa |
|---|---|
| `PORT` | Cổng chạy, mặc định `4000` |
| `API_KEY_BLOG`, `API_KEY_CELLPHONES`, `API_KEY_JOB_PORTAL` | Key của từng web. Mỗi key ≥ 32 ký tự và **phải khác nhau** |
| `STORAGE_REGION` | `auto` |
| `STORAGE_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` (không thêm tên bucket) |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | Khoá API của R2 (cần quyền đọc/ghi trên cả hai bucket) |
| `STORAGE_BUCKET_NAME` | Bucket **public** |
| `STORAGE_PRIVATE_BUCKET_NAME` | Bucket **private** (phải khác bucket public) |
| `STORAGE_PUBLIC_URL` | Địa chỉ công khai của bucket public (r2.dev hoặc domain riêng) |

Cấu hình sai thì server in danh sách biến lỗi rồi thoát. Tạo key ngẫu nhiên:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Chạy:

```bash
npm install
npm run dev          # chạy dev, tự reload
npm run build && npm start   # chạy bản build (dùng khi triển khai)
```

### Bucket và quy tắc dọn temp

- **Bucket private** tuyệt đối không bật public access (cả r2.dev lẫn domain riêng). Link r2.dev/domain riêng của R2 phơi toàn bộ bucket, nên bật là lộ CV.
- **Dọn `temp/`:** service **không tự xoá** thư mục `temp/`. Cả file chưa confirm lẫn bản tạm của file đã confirm đều nằm đó cho đến khi bị dọn. Trên **cả hai bucket**, nên thêm Object Lifecycle rule: xoá object có prefix `temp/` sau 1 ngày (chưa thêm thì `temp/` sẽ đầy dần).
- **CORS (cần khi trình duyệt PUT thẳng lên R2):** trong cài đặt CORS của **cả hai bucket**, thêm ví dụ:

```json
[
  {
    "AllowedOrigins": ["https://blog.example.com", "https://cellphones.example.com", "https://jobs.example.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

## 8. Triển khai lên server

1. Đặt các biến ở mục 7 trong cấu hình môi trường của host (đừng commit `.env`).
2. Build lệnh: `npm install && npm run build`. Start lệnh: `npm start` (chạy `node dist/index.js`, cần Node 20+).
3. Health check trỏ vào `GET /health`.
4. Chạy sau HTTPS. API key đi trong header nên không được dùng HTTP thường qua Internet.
5. Mỗi web nhận **đúng key của mình**, đặt trong backend của web đó.

Lưu ý trước khi mở ra Internet:

- Service hiện cho phép mọi origin gọi (`cors()` mở). Vì API key nằm ở backend nên điều này không làm lộ key, nhưng nếu chỉ backend của bạn gọi thì nên giới hạn ở tầng proxy hoặc firewall.
- Chưa có giới hạn tần suất (rate limit). Nếu cần, đặt ở reverse proxy hoặc dịch vụ phía trước.
- Muốn đổi key: thay giá trị biến môi trường và khởi động lại; web tương ứng cập nhật key mới.

## 9. Test API

- **Postman:** import `postman/file-service.postman_collection.json`, điền `apiKey*`, `publicUrl` ở tab Variables. File mẫu để chọn ở các request PUT nằm trong `postman/files/` (`test.png`, `one.png`, `two.png`, `three.png`, `cv.pdf`).
- **Dòng lệnh:** `npm run case` liệt kê các case, `npm run case -- <tên-case>` chạy từng case và in request/response, `npm run case -- all` chạy hết rồi tự dọn. Đặt `API_BASE` nếu server không ở `http://localhost:4000`.

> Các case upload ghi vào bucket thật (và tự xoá sau khi chạy). Nếu dừng giữa chừng, chạy `npm run case -- cleanup`.

## 10. Thêm app hoặc context mới

- **Thêm context cho app có sẵn:** chỉ sửa `src/config/app-policies.ts`.
- **Thêm app mới:** thêm tên vào `AppName` và `APP_POLICIES` (`src/config/app-policies.ts`), thêm biến `API_KEY_<APP>` vào `src/config/env.ts`, rồi thêm vào bảng `APP_KEYS` trong `src/middlewares/api-key.middleware.ts`.
