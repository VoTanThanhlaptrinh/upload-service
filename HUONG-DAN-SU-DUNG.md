# Hướng dẫn sử dụng file-service

Service upload file dùng chung cho 3 web: **blog**, **cellphones**, **job-portal**. File lưu trên Cloudflare R2. Service không nhận file trực tiếp: nó cấp link upload tạm (presigned URL), rồi trình duyệt upload **thẳng lên R2**.

- **Base URL (production):** `https://upload-service-gamma.vercel.app`
- **API:** `https://upload-service-gamma.vercel.app/api/v1/files`
- Tài liệu chi tiết đầy đủ (lỗi, cấu hình bucket, CORS...): xem [README.md](README.md)

---

## 1. Chuẩn bị

Bạn cần **API key của web mình** (mỗi web một key riêng), gửi trong header:

```
x-api-key: <key của web bạn>
```

| Web | Context dùng được | Loại | Định dạng | Tối đa / file | Tối đa file / lần |
|---|---|---|---|---|---|
| blog | `post-image` | public | jpeg, png, webp, gif | 5 MB | 10 |
| blog | `avatar` | public | jpeg, png, webp | 2 MB | 1 |
| cellphones | `product-gallery` | public | jpeg, png, webp | 2 MB | 8 |
| job-portal | `company-logo` | public | jpeg, png, webp | 2 MB | 1 |
| job-portal | `candidate-cv` | **private** | pdf, doc, docx | 10 MB | 1 |

> **Quan trọng:** chỉ để API key ở **backend**. Không đưa vào code chạy trên trình duyệt hay app mobile.

## 2. Kiểm tra service còn sống

```bash
curl https://upload-service-gamma.vercel.app/health
```

Kết quả đúng: `{"status":"ok","service":"file-service","timestamp":"..."}`. Endpoint này không cần API key.

## 3. Luồng upload (3 bước)

```
Backend  ── POST /presign ──►  file-service   → trả tempKey + uploadUrl
Trình duyệt ── PUT uploadUrl (gửi file) ──►  R2   (lưu ở temp/)
Backend  ── POST /confirm ──►  file-service   → trả key (+ url nếu public)
```

### Bước 1: Xin link upload (backend)

```bash
curl -X POST https://upload-service-gamma.vercel.app/api/v1/files/presign \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"context":"post-image","file":{"fileName":"anh.png","mimeType":"image/png","size":183204}}'
```

- `size` phải là **số byte thật** của file, nếu không R2 sẽ từ chối ở bước 2.
- Response có `data.tempKey` (giữ lại để confirm) và `data.uploadUrl` (sống 10 phút).
- Nhiều file một lần: `POST /presign-batch` với `{"context":"...","files":[...]}`.

### Bước 2: Upload file (trình duyệt hoặc backend)

Gọi **thẳng** `uploadUrl` bằng `PUT`, **không** gửi `x-api-key`:

```bash
curl -X PUT "<uploadUrl>" -H "Content-Type: image/png" --data-binary @anh.png
```

Thành công khi nhận `200`. Với JavaScript trên trình duyệt:

```js
const res = await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': file.type },
  body: file, // đối tượng File từ <input type="file">
});
if (!res.ok) throw new Error('Upload lỗi: ' + res.status);
```

### Bước 3: Xác nhận (backend)

Gọi sau khi người dùng lưu form/bài viết thành công:

```bash
curl -X POST https://upload-service-gamma.vercel.app/api/v1/files/confirm \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"tempKey":"<tempKey>"}'
```

- File **public**: response có `data.key` và `data.url` (link xem được ngay). Lưu cả hai vào database.
- File **private**: `data.url` là `null`. Chỉ lưu `data.key`.
- Nhiều file: `POST /confirm-batch` với `{"tempKeys":["..."]}`.
- Không confirm thì file chỉ nằm ở `temp/` và sẽ bị dọn đi.

## 4. Các thao tác khác

### Xem file private (CV)

```bash
curl -X POST https://upload-service-gamma.vercel.app/api/v1/files/read-url \
  -H "x-api-key: $API_KEY_JOB_PORTAL" -H "Content-Type: application/json" \
  -d '{"key":"private/job-portal/candidate-cv/2026-11/xxxx.pdf","downloadFileName":"Nguyen Van A.pdf"}'
```

Trả `data.readUrl`, mở được trong **15 phút**. Tạo link mới mỗi lần cần xem, đừng lưu link vào database.

### Xoá file

```bash
# 1 file
curl -X DELETE https://upload-service-gamma.vercel.app/api/v1/files \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"key":"public/blog/post-image/2026-11/xxxx.png"}'

# nhiều file (tối đa 1000)
curl -X POST https://upload-service-gamma.vercel.app/api/v1/files/delete-batch \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"keys":["public/blog/post-image/2026-11/a.png","public/blog/post-image/2026-11/b.png"]}'
```

Chỉ xoá được file của app mình. Nếu một key thuộc app khác, cả batch bị từ chối.

### Bảng endpoint

| Method | Đường dẫn | Việc |
|---|---|---|
| GET | `/health` | Kiểm tra service (không cần key) |
| POST | `/api/v1/files/presign` | Link upload cho 1 file |
| POST | `/api/v1/files/presign-batch` | Link upload cho nhiều file |
| POST | `/api/v1/files/confirm` | Xác nhận 1 file |
| POST | `/api/v1/files/confirm-batch` | Xác nhận nhiều file |
| POST | `/api/v1/files/read-url` | Link đọc file private |
| DELETE | `/api/v1/files` | Xoá 1 file |
| POST | `/api/v1/files/delete-batch` | Xoá nhiều file |

## 5. Mã lỗi thường gặp

Response lỗi luôn có dạng `{"success":false,"message":"..."}`.

| HTTP | Ý nghĩa | Cách xử lý |
|---|---|---|
| 400 | Body sai, sai MIME, quá dung lượng, sai context, key không hợp lệ hoặc không thuộc app của bạn, JSON sai cú pháp | Đọc `message` (có thêm mảng `issues` khi lỗi do dữ liệu nhập) rồi sửa request |
| 401 | Thiếu hoặc sai `x-api-key` | Kiểm tra lại key của web mình |
| 404 | Route không tồn tại, hoặc file chưa được upload lên R2 khi confirm | Kiểm tra URL, hoặc đảm bảo bước 2 đã trả 200 |
| 502 | R2 trả lỗi | Thử lại sau, báo quản trị nếu lặp lại |
| 503 | Service không kết nối được R2 | Thử lại sau |

Lỗi khi **PUT lên R2** (bước 2) do R2 trả về:

| Triệu chứng | Nguyên nhân |
|---|---|
| `403 SignatureDoesNotMatch` | Dung lượng hoặc `Content-Type` thật khác với khai báo ở presign. Khai báo đúng rồi xin link mới |
| `403` | Link quá 10 phút. Xin link mới |
| Lỗi CORS trên trình duyệt | Bucket R2 chưa cấu hình CORS cho domain của web (xem mục CORS trong [README.md](README.md)) |

## 6. Triển khai trên Vercel (dành cho quản trị)

Repo đã có `api/index.ts` và `vercel.json` để chạy trên Vercel. Service **bắt buộc** có đủ biến môi trường, nếu thiếu thì mọi request (kể cả `/health`) đều trả `500 FUNCTION_INVOCATION_FAILED`.

Vào Vercel → Project → Settings → Environment Variables và thêm (áp dụng cho Production):

| Biến | Ghi chú |
|---|---|
| `API_KEY_BLOG`, `API_KEY_CELLPHONES`, `API_KEY_JOB_PORTAL` | Mỗi key ≥ 32 ký tự và phải khác nhau |
| `STORAGE_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | Khoá API của R2 |
| `STORAGE_BUCKET_NAME` | Bucket public |
| `STORAGE_PRIVATE_BUCKET_NAME` | Bucket private (khác bucket public, không bật public access) |
| `STORAGE_PUBLIC_URL` | Địa chỉ công khai của bucket public |
| `STORAGE_REGION` | Tuỳ chọn, mặc định `auto` |

Sau khi thêm biến phải **redeploy** thì mới có hiệu lực. Kiểm tra bằng `curl https://upload-service-gamma.vercel.app/health`.

Xem log khi có lỗi:

```bash
vercel logs https://upload-service-gamma.vercel.app --no-follow --expand
```

## 7. Test nhanh bằng bộ case có sẵn

```bash
API_BASE=https://upload-service-gamma.vercel.app npm run case -- all
```

Lệnh này đọc API key từ file `.env` local, ghi file thử vào bucket thật rồi tự xoá. Chỉ chạy sau khi service production đã `/health` OK.
