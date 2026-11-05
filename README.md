# Quán Nhà — quản lý order

Ứng dụng Next.js, PostgreSQL và Prisma cho đặt món, POS, bếp, giao hàng, thu chi và thanh toán APIBank.

## Chạy tại máy phát triển

Yêu cầu Node.js 22.12 trở lên, npm và PostgreSQL. Dùng `npm.cmd` trên Windows nếu lệnh `npm` bị một chương trình khác trong PATH che khuất.

1. Chạy `npm ci`.
2. Sao chép `.env.example` thành `.env`, cấu hình `DATABASE_URL`, `BETTER_AUTH_SECRET`, `APP_URL` và `BETTER_AUTH_URL`. Hai URL ở máy phát triển là `http://127.0.0.1:3100`.
3. Chạy `npm run db:generate` và `npm run db:migrate`.
4. Chạy `npm run seed:demo` để tạo thực đơn và tài khoản thử trên PostgreSQL local. Mật khẩu được ghi vào `.runtime/local-access.txt`, không đưa tệp này lên kho mã nguồn.
5. Chạy `npm run dev`, mở [menu](http://127.0.0.1:3100/menu) hoặc [đăng nhập nhân viên](http://127.0.0.1:3100/login).

Ảnh thực đơn mẫu trong `public/demo/` lấy từ [Unsplash](https://unsplash.com/license). `scripts/download-demo-images.mjs` lưu các nguồn ảnh dùng cho bản demo.

Chế độ `MANUAL` dùng được khi chưa cấu hình ngân hàng. Muốn dùng APIBank, điền bốn biến `APIBANK_*` trong `.env`, chọn chế độ APIBank trong cài đặt quán và chạy `npm run worker` ở tiến trình riêng. Đăng ký webhook `/api/payments/apibank/webhook` tại APIBank. Worker dùng API đối soát để phục hồi khi webhook không đến. Chỉ đặt `APIBANK_ALLOW_HTTP=1` cho APIBank local khi phát triển.

## Kiểm tra trước khi sử dụng

```sh
npm test
npm run test:integration
npm run typecheck
npm run build
```

Kiểm thử tích hợp chạy trực tiếp route handler với PostgreSQL thật, phiên đăng nhập thật và máy chủ APIBank giả lập tại loopback. Không tạo giao dịch ngân hàng thật và không cần khởi động Next.js.

Mỗi lần chạy tạo database `order_test_<uuid>`, áp dụng các migration, chạy kiểm tra rồi xóa database đó trong phần dọn dẹp. Kết nối phải là PostgreSQL local và tài khoản cần quyền `CREATEDB`. Có thể đặt `TEST_DATABASE_URL` để dùng PostgreSQL kiểm thử khác trên máy; nếu không, dùng thông tin kết nối từ `DATABASE_URL` để tạo database riêng. Không xóa hay đặt lại database ứng dụng. Nếu tiến trình bị buộc dừng trước phần dọn dẹp, database tạm có thể còn lại.

Các trường hợp đã kiểm tra gồm phân quyền, yêu cầu lặp, tính giá, phiên bản đơn, chuyển hình thức nhận món, giao hàng/COD, ghi chi phí một lần, nhận tiền đồng thời, tạo QR đồng thời, webhook lặp hoặc đến trước phản hồi API, QR đã hủy, đối soát giao dịch sai số tiền/hết hạn, hoàn tiền và worker.

## Quy tắc vận hành

### Gọi món và thanh toán bằng QR bàn

- Vào **Bàn & QR** để chủ quán thêm bàn, đặt khu vực/số chỗ, sửa thông tin hoặc tạm ngưng phục vụ. Thu ngân xem bàn và xử lý lượt khách; nhân viên bếp không truy cập quản lý bàn.
- Chọn **QR bàn** để tải SVG hoặc **In thẻ bàn**; **In QR các bàn** tạo trang in hàng loạt và hỗ trợ lưu PDF bằng hộp thoại in. QR được tạo trên máy chủ, không gửi đường dẫn bàn cho dịch vụ QR bên ngoài.
- QR mở `/t/<mã-bí-mật>` trên tên miền lấy từ `APP_URL`. Khi triển khai website của quán, đặt `APP_URL` và `BETTER_AUTH_URL` thành cùng URL HTTPS công khai rồi khởi động lại ứng dụng **trước khi in**. QR localhost chỉ phục vụ phát triển, không dùng được từ điện thoại khách.
- Khách không cần tài khoản: quét QR để vào đúng bàn, gửi món và gọi thêm. Các điện thoại tại cùng bàn dùng chung một lượt phục vụ. Nút **Xem bàn và gọi thêm món** trên trang theo dõi mở đúng lượt đó. Tên bàn được máy chủ xác định từ lượt khách, không tin tên bàn tự nhập.
- Trạng thái bàn tự cập nhật mỗi 5 giây. Giới hạn cập nhật được tính theo lượt khách và IP để nhiều bàn dùng chung Wi-Fi không chặn lẫn nhau; vẫn có giới hạn tổng để ngăn yêu cầu quá dày.
- **Gọi thanh toán** thông báo trên các màn hình của chủ quán/thu ngân. Khách được thấy trạng thái chờ hoặc đã tiếp nhận. Thao tác này không ghi nhận đã thu tiền. Khi đã gọi thanh toán, khách tạm dừng gọi thêm; nhân viên có thể chọn **Cho gọi thêm món**.
- Nhân viên mở từng order để xác nhận món, xử lý bếp và ghi nhận tiền như luồng hiện có; **In hóa đơn bàn** tổng hợp các order chưa hủy trong lượt và số tiền còn phải thu.
- **Kết thúc lượt khách** chỉ thực hiện được khi các món đã hoàn tất và các khoản thanh toán/hoàn tiền đã xử lý, hoặc lượt chưa có order. QR dán bàn giữ nguyên; lần quét tiếp theo mở lượt mới. Token lượt cũ không thể đặt thêm món hay yêu cầu thanh toán, không thấy đơn của khách mới.
- **Đổi mã QR** chỉ dành cho trường hợp chủ quán cần vô hiệu mã đang dán và bàn đã đóng lượt hiện tại. Khi đó cần in lại và thay mã trên bàn. Tạm ngưng bàn cũng yêu cầu đóng lượt hiện tại trước.

Trang bàn công khai chỉ hiển thị món, số order, tổng tiền và trạng thái của lượt hiện tại; không trả tên khách, điện thoại, địa chỉ hay mã theo dõi riêng của từng order. QR là mã truy cập dành cho người tại bàn; nhân viên vẫn xác nhận đơn trước khi chế biến.

### Đơn và thu chi

- Đơn chuyển khoản chỉ vào hàng đợi bếp sau khi nhận đủ tiền; tiền mặt/COD có thể vào bếp sau khi xác nhận.
- Chỉ điều phối giao hàng sau khi xác nhận đơn. Chuyển sang mang về/tại bàn sẽ xóa chuyến giao chưa ghi chi phí; đã chi tiền thì cần xử lý riêng, hệ thống không xóa chứng từ.
- Giao thành công không đồng nghĩa đã thu tiền. Nhân viên ghi nhận COD sau khi thực sự nhận đủ tiền.
- Giao dịch cần đối soát không được tự ghi đè thành QR đang chờ. Khách được hướng dẫn liên hệ quán; yêu cầu thanh toán mới bị chặn đến khi chủ quán xử lý giao dịch trong màn hình đối soát.
- Trạng thái APIBank `review` được theo dõi tiếp bởi worker, đồng thời ẩn QR để khách không chuyển thêm tiền.
- Chỉ chủ quán được hủy đơn đã thanh toán/đang chế biến và ghi hoàn tiền. Việc hoàn tiền được thực hiện bên ngoài trước khi ghi nhận trong ứng dụng.

## Build và chạy production

Cấu hình URL HTTPS, khóa bí mật riêng và PostgreSQL production. Đặt `UPLOAD_DIR` thành đường dẫn tuyệt đối đến thư mục lưu bền vững có quyền đọc/ghi và sao lưu cùng database. Chạy `npm ci`, `npm run build` và `npm run db:migrate`. Khi triển khai lần đầu, đặt `OWNER_EMAIL` trong `.env`, chạy `npm run owner:create` để tạo chủ quán và đọc thông tin đăng nhập tại `.runtime/owner-access.txt`.

Trên Linux, sao chép tài nguyên tĩnh vào đầu ra standalone rồi chạy máy chủ bằng trình quản lý tiến trình.

```sh
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
HOSTNAME=0.0.0.0 PORT=3100 node --env-file=.env .next/standalone/server.js
```

Chạy `npm run worker` ở tiến trình riêng từ thư mục dự án.

Kiểm thử với APIBank giả lập không thay thế việc xác nhận cấu hình tài khoản, webhook và một giao dịch kiểm thử có kiểm soát trước khi vận hành thật.
