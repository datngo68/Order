import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import type { OrderInput } from '../src/lib/domain';
import type { OrderView } from '../src/components/types';

async function main() {
  const source = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Integration tests require local PostgreSQL.');
  assert.notEqual(process.env.NODE_ENV, 'production', 'Do not run integration tests in production.');
  const database = 'order_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Client({ connectionString: source.toString() });
  await admin.connect();
  let created = false;
  let db: (typeof import('../src/lib/db'))['db'] | undefined;
  let passed = 0;
  let failed = 0;
  const remotes = new Map<string, Record<string, unknown>>();
  const keys = new Map<string, string>();
  let createCount = 0;
  let nextCreate: 'pending' | 'cancelled' | 'review' | 'review-race' = 'pending';
  let beforeCreateResponse: ((remote: Record<string, unknown>) => Promise<void>) | undefined;
  const bank = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer integration-only');
      let remote: Record<string, unknown> | undefined;
      if (request.url === '/v1/orders' && request.method === 'POST') {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const input = JSON.parse(raw);
        const key = String(request.headers['idempotency-key']);
        const existing = keys.get(key);
        if (existing) remote = remotes.get(existing);
        else {
          const id = randomUUID();
          remote = { id, amount_vnd: input.amount_vnd, status: nextCreate === 'cancelled' ? 'cancelled' : nextCreate === 'review' ? 'review' : 'pending', pay_url: '/pay/' + id, transfer_content: 'TEST ' + id, expired_at: new Date(Date.now() + 900000).toISOString(), metadata: input.metadata };
          keys.set(key, id);
          remotes.set(id, remote);
          createCount++;
        }
        if (nextCreate === 'review-race') await beforeCreateResponse?.(remote!);
        nextCreate = 'pending';
      } else {
        const id = decodeURIComponent((request.url ?? '').replace('/v1/orders/', '').replace(':cancel', ''));
        remote = remotes.get(id);
        if (remote && request.url?.endsWith(':cancel') && remote.status !== 'paid') remote.status = 'cancelled';
      }
      response.writeHead(remote ? 200 : 404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(remote ?? { error: 'not found' }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'mock error' }));
    }
  });
  async function check(name: string, run: () => Promise<void>) {
    try { await run(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name, error); }
  }
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    source.pathname = '/' + database;
    process.env.DATABASE_URL = source.toString();
    process.env.APP_URL = 'http://127.0.0.1:3100';
    process.env.TRUST_PROXY = '1';
    process.env.BETTER_AUTH_URL = process.env.APP_URL;
    process.env.BETTER_AUTH_SECRET = randomUUID() + randomUUID();
    const migrationDb = new pg.Client({ connectionString: source.toString() });
    await migrationDb.connect();
    try {
      const root = path.resolve('prisma/migrations');
      const migrations = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      for (const migration of migrations) await migrationDb.query(await readFile(path.join(root, migration.name, 'migration.sql'), 'utf8'));
    } finally { await migrationDb.end(); }
    await new Promise<void>(resolve => bank.listen(0, '127.0.0.1', resolve));
    const address = bank.address();
    assert.ok(address && typeof address !== 'string');
    process.env.APIBANK_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.APIBANK_ALLOW_HTTP = '1';
    process.env.APIBANK_API_KEY = 'integration-only';
    process.env.APIBANK_BANK_ACCOUNT_ID = 'test-account';
    process.env.APIBANK_WEBHOOK_SECRET = 'integration-only-webhook';
    ({ db } = await import('../src/lib/db'));
    const store = db;
    const { auth } = await import('../src/lib/auth');
    const { GET, POST } = await import('../src/app/api/[...path]/route');
    const { beginPayment, applyBankEvent, cancelActivePayments, paymentWorkerTick } = await import('../src/lib/payments');
    const { getOrder, orderAction, confirmOrder } = await import('../src/lib/orders');
    const { getTableBillVisit } = await import('../src/lib/tables');
    await store.shop.create({ data: { id: 'main', taxBps: 800, paymentMode: 'APIBANK' } });
    await store.category.create({ data: { id: 'food', name: 'Món thử' } });
    await store.product.create({ data: { id: 'bread', categoryId: 'food', name: 'Bánh mì', price: 30000, optionGroups: [{ id: 'extra', name: 'Thêm', min: 1, max: 1, options: [{ id: 'egg', name: 'Trứng', price: 5000 }] }] } });
    await store.coupon.create({ data: { code: 'TEST10', type: 'PERCENT', value: 10 } });
    const password = randomUUID() + '!test';
    const sessions: Record<string, string> = {};
    const actors: Record<string, { id: string; name: string; role: string }> = {};
    for (const role of ['OWNER', 'CASHIER', 'KITCHEN'] as const) {
      const email = role.toLowerCase() + '@integration.example';
      const { user } = await auth.api.createUser({ body: { name: role, email, password, role } });
      actors[role] = { id: user.id, name: user.name, role };
      const result = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
      assert.equal(result.status, 200);
      sessions[role] = result.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
      assert.ok(sessions[role]);
    }
    async function request(route: string, data?: unknown, role?: string, expected = 200, ip?: string) {
      const url = new URL('/api/' + route, process.env.APP_URL);
      const headers = new Headers({ Origin: process.env.APP_URL!, 'Content-Type': 'application/json' });
      if (ip) headers.set('X-Forwarded-For', ip);
      if (role) headers.set('Cookie', sessions[role]);
      const req = new Request(url, { method: data === undefined ? 'GET' : 'POST', headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const context = { params: Promise.resolve({ path: url.pathname.slice(5).split('/') }) };
      const response = await (data === undefined ? GET : POST)(req, context);
      const result = await response.json();
      assert.equal(response.status, expected, `${route}: ${JSON.stringify(result)}`);
      return result;
    }
    function input(overrides: Partial<OrderInput> = {}): OrderInput {
      return { key: randomUUID(), type: 'TAKEAWAY', paymentMethod: 'CASH', customerName: '', phone: '', address: '', tableName: '', note: '', couponCode: '', items: [{ productId: 'bread', selected: ['egg'], quantity: 2, note: '' }], ...overrides };
    }
    async function create(overrides: Partial<OrderInput> = {}): Promise<OrderView> {
      const created = await request('pos/orders', input(overrides), 'CASHIER', 201);
      return request('orders/' + created.id, undefined, 'CASHIER');
    }
    async function action(order: { id: string; version: number }, name: string, extra: Record<string, unknown> = {}, role = 'CASHIER'): Promise<OrderView> {
      return request(`orders/${order.id}/${name}`, { version: order.version, ...extra }, role);
    }
    const deliveryInput = { type: 'DELIVERY', paymentMethod: 'COD', customerName: 'Khách thử', phone: '0901234567', address: 'Địa chỉ thử' } as const;
    const deliveryForm = (order: OrderView, overrides: Record<string, unknown> = {}) => ({ version: order.delivery!.version, courier: 'Người giao thử', courierPhone: '0909999999', status: 'ASSIGNED', cost: 10000, note: '', ...overrides });
    async function transfer() {
      const order = await create({ paymentMethod: 'TRANSFER' });
      return action(order, 'confirm', { taxBps: 800, shipping: 0 });
    }
    function event(attempt: { externalId: string | null; amount: number }, overrides: Record<string, unknown> = {}) {
      return { id: randomUUID(), type: 'payment.succeeded', data: { order_id: attempt.externalId, transaction_id: randomUUID(), amount_vnd: attempt.amount, posted_at: new Date().toISOString(), ...overrides } };
    }

    await check('API phân quyền khách, thu ngân, bếp và chủ quán', async () => {
      await request('orders', undefined, undefined, 401);
      await request('orders', undefined, 'KITCHEN', 403);
      await request('reports', undefined, 'CASHIER', 403);
      await request('kitchen', undefined, 'KITCHEN');
      await request('reports', undefined, 'OWNER');
    });
    await check('Chặn admin better-auth trực tiếp nhưng route nhân viên riêng vẫn dùng được', async () => {
      const authRoutes = await import('../src/app/api/auth/[...all]/route');
      for (const endpoint of ['set-user-password', 'create-user', 'ban-user', 'revoke-user-sessions']) {
        for (const method of ['GET', 'POST'] as const) {
          const response = await authRoutes[method](new Request(process.env.APP_URL + '/api/auth/admin/' + endpoint, { method, headers: { Cookie: sessions.OWNER } }));
          assert.equal(response.status, 404);
        }
      }
      const user = await request('manage/staff', { name: 'Nhân viên mới', username: 'new_staff', email: 'new@integration.example', password, role: 'CASHIER' }, 'OWNER', 201);
      assert.ok(user.user.id);
      await request('manage/staff-action', { userId: user.user.id, action: 'ban' }, 'OWNER');
      assert.equal((await store.user.findUniqueOrThrow({ where: { id: user.user.id } })).banned, true);
    });
    await check('Bật/tắt hết món chỉ cập nhật available và ghi audit', async () => {
      const original = await store.product.findUniqueOrThrow({ where: { id: 'bread' } });
      await request('manage/products/bread/availability', { available: false, price: 1, name: 'Dữ liệu cũ', optionGroups: [] }, 'OWNER');
      const changed = await store.product.findUniqueOrThrow({ where: { id: 'bread' } });
      assert.equal(changed.available, false);
      assert.equal(changed.price, original.price);
      assert.equal(changed.name, original.name);
      assert.deepEqual(changed.optionGroups, original.optionGroups);
      assert.equal(await store.audit.count({ where: { action: 'PRODUCT_AVAILABILITY', targetId: 'bread' } }), 1);
      await request('manage/products/bread/availability', { available: true }, 'OWNER');
    });
    await check('Phiếu mua gửi đồng thời/gửi lại chỉ tạo một phiếu và một khoản chi', async () => {
      const ingredient = await store.ingredient.create({ data: { name: 'Bột kiểm thử', unit: 'kg' } });
      const form = { requestId: randomUUID(), supplier: 'Nhà cung cấp thử', purchasedAt: new Date().toISOString(), paidAt: new Date().toISOString(), note: '', items: [{ ingredientId: ingredient.id, quantity: 2, unitPrice: 30000 }] };
      const [a, b] = await Promise.all([request('manage/purchases', form, 'OWNER', 201), request('manage/purchases', form, 'OWNER', 201)]);
      assert.equal(a.id, b.id);
      await store.ingredient.update({ where: { id: ingredient.id }, data: { active: false } });
      const retry = await request('manage/purchases', { ...form, supplier: 'Tên sửa sau khi gửi' }, 'OWNER', 201);
      assert.equal(retry.id, a.id);
      assert.equal(retry.supplier, form.supplier);
      assert.equal(await store.purchase.count({ where: { requestId: form.requestId } }), 1);
      assert.equal(await store.expense.count({ where: { purchaseId: a.id } }), 1);
    });
    await check('Khoản chi gửi đồng thời/gửi lại giữ nguyên bản ghi đầu tiên', async () => {
      const form = { requestId: randomUUID(), category: 'OTHER', amount: 10000, note: 'Chi kiểm thử', paidAt: new Date().toISOString() };
      const [a, b] = await Promise.all([request('manage/expenses', form, 'OWNER', 201), request('manage/expenses', form, 'OWNER', 201)]);
      assert.equal(a.id, b.id);
      const retry = await request('manage/expenses', { ...form, amount: 20000 }, 'OWNER', 201);
      assert.equal(retry.id, a.id);
      assert.equal(retry.amount, 10000);
      assert.equal(await store.expense.count({ where: { requestId: form.requestId } }), 1);
      const next = await request('manage/expenses', { ...form, requestId: randomUUID() }, 'OWNER', 201);
      assert.notEqual(next.id, a.id);
    });
    await check('Đặt lại cùng yêu cầu chỉ tạo một đơn; nội dung khác bị từ chối', async () => {
      const body = input();
      const [a, b] = await Promise.all([request('orders', body, undefined, 201), request('orders', body, undefined, 201)]);
      assert.equal(a.id, b.id);
      await request('orders', { ...body, note: 'khác' }, undefined, 409);
      assert.equal(await store.order.count({ where: { creationKey: body.key } }), 1);
    });
    await check('Định giá server, xác nhận 83.040đ và xung đột phiên bản', async () => {
      const order = await create({ ...deliveryInput, couponCode: 'TEST10' });
      const confirmed = await action(order, 'confirm', { taxBps: 800, shipping: 15000 });
      assert.equal(confirmed.total, 83040);
      assert.ok(confirmed.queuedAt);
      await request(`orders/${order.id}/confirm`, { version: order.version, taxBps: 0, shipping: 0 }, 'CASHIER', 409);
    });
    await check('Đổi giao hàng sang mang về xóa chuyến giao cũ', async () => {
      const order = await create(deliveryInput);
      const edited = await action(order, 'edit', { order: input() });
      assert.equal(edited.type, 'TAKEAWAY');
      assert.equal(edited.delivery, null);
    });
    await check('Không điều phối hoặc chi tiền giao cho đơn chưa xác nhận', async () => {
      const order = await create(deliveryInput);
      await request('deliveries/' + order.delivery!.id, deliveryForm(order, { payCost: true }), 'CASHIER', 409);
      assert.equal(await store.expense.count({ where: { deliveryId: order.delivery!.id } }), 0);
    });
    await check('Đổi hình thức nhận món không làm mất chi phí giao đã ghi nhận', async () => {
      let order = await action(await create(deliveryInput), 'confirm', { taxBps: 0, shipping: 0 });
      await request('deliveries/' + order.delivery!.id, deliveryForm(order, { payCost: true }), 'CASHIER');
      order = await action(order, 'reopen', { note: 'Khách muốn đổi cách nhận món' });
      await request(`orders/${order.id}/edit`, { version: order.version, order: input() }, 'CASHIER', 409);
      const unchanged = await getOrder(order.id);
      assert.equal(unchanged.type, 'DELIVERY');
      assert.equal(unchanged.delivery?.expense?.amount, 10000);
    });
    await check('Luồng bếp → giao hàng → thu COD; chi phí giao không bị ghi hai lần', async () => {
      let order = await create(deliveryInput);
      order = await action(order, 'confirm', { taxBps: 0, shipping: 15000 });
      await request('deliveries/' + order.delivery!.id, deliveryForm(order), 'CASHIER');
      order = await request('orders/' + order.id, undefined, 'CASHIER');
      await request('deliveries/' + order.delivery!.id, deliveryForm(order, { status: 'IN_TRANSIT' }), 'CASHIER', 400);
      order = await action(order, 'start', {}, 'OWNER');
      order = await action(order, 'ready', {}, 'OWNER');
      await request('deliveries/' + order.delivery!.id, deliveryForm(order, { status: 'IN_TRANSIT' }), 'CASHIER');
      order = await request('orders/' + order.id, undefined, 'CASHIER');
      await request('deliveries/' + order.delivery!.id, deliveryForm(order, { status: 'DELIVERED', payCost: true }), 'CASHIER');
      order = await request('orders/' + order.id, undefined, 'CASHIER');
      assert.equal(order.status, 'COMPLETED');
      assert.equal(order.paymentStatus, 'UNPAID');
      order = await action(order, 'manual-pay', { note: 'Đã thu COD' });
      assert.equal(order.paymentStatus, 'PAID');
      const form = deliveryForm(order, { status: 'DELIVERED', payCost: true });
      await request('deliveries/' + order.delivery!.id, form, 'CASHIER');
      await request('deliveries/' + order.delivery!.id, form, 'CASHIER', 409);
      assert.equal(await store.expense.count({ where: { deliveryId: order.delivery!.id } }), 1);
    });
    await check('Đơn không tồn tại trả 404', async () => { await request('orders/missing-order', undefined, 'OWNER', 404); });
    await check('Tìm đơn bằng số order hoặc điện thoại và chuẩn hóa số trang', async () => {
      const phone = '84912345678';
      const order = await create({ ...deliveryInput, phone });
      const byPhone = await request(`orders?q=${phone}&page=1.5`, undefined, 'CASHIER');
      assert.equal(byPhone.page, 1);
      assert.equal(byPhone.count, 1);
      assert.equal(byPhone.orders[0].id, order.id);
      const byNumber = await request(`orders?q=${order.number}`, undefined, 'CASHIER');
      assert.ok(byNumber.orders.some((item: OrderView) => item.id === order.id));
      await request('manage/finances?page=Infinity', undefined, 'OWNER');
    });
    await check('Hai lần nhận tiền đồng thời chỉ tạo một phiếu thu', async () => {
      const order = await action(await create(), 'confirm', { taxBps: 0, shipping: 0 });
      const results = await Promise.allSettled([orderAction(order.id, order.version, 'manual-pay', actors.CASHIER, 'Đã nhận tiền'), orderAction(order.id, order.version, 'manual-pay', actors.CASHIER, 'Đã nhận tiền')]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(await store.paymentRecord.count({ where: { orderId: order.id } }), 1);
    });
    await check('Tạo QR đồng thời dùng chung một yêu cầu thanh toán', async () => {
      const order = await transfer();
      const before = createCount;
      const [a, b] = await Promise.all([beginPayment(order.id), beginPayment(order.id)]);
      assert.equal(a.id, b.id);
      assert.equal(createCount - before, 1);
      assert.equal(await store.paymentAttempt.count({ where: { orderId: order.id } }), 1);
    });
    await check('Webhook lặp và đối soát không ghi nhận tiền hai lần; tiền mở hàng đợi bếp', async () => {
      const order = await transfer();
      assert.equal(order.queuedAt, null);
      const attempt = await beginPayment(order.id);
      const payload = event(attempt);
      assert.deepEqual(await Promise.all([applyBankEvent(payload), applyBankEvent(payload)]), ['APPLIED', 'APPLIED']);
      assert.equal(await applyBankEvent({ ...payload, id: randomUUID() }), 'APPLIED');
      const paid = await getOrder(order.id);
      assert.equal(paid.paymentStatus, 'PAID');
      assert.ok(paid.queuedAt);
      assert.equal(paid.records.length, 1);
      const tracked = await request('track/' + order.token);
      assert.equal('attempts' in tracked, false);
      assert.equal('actorId' in tracked.events[0], false);
    });
    await check('Sai số tiền chuyển sang đối soát và không mở hàng đợi bếp', async () => {
      const order = await transfer();
      const attempt = await beginPayment(order.id);
      assert.equal(await applyBankEvent(event(attempt, { amount_vnd: attempt.amount - 1 })), 'REVIEW');
      const current = await getOrder(order.id);
      assert.equal(current.paymentStatus, 'UNPAID');
      assert.equal(current.queuedAt, null);
      assert.equal(current.records.length, 0);
    });
    await check('Chặn thanh toán thêm cho đến khi chủ quán xử lý đối soát', async () => {
      const order = await transfer();
      const attempt = await beginPayment(order.id);
      const payload = event(attempt, { amount_vnd: attempt.amount - 1 });
      await applyBankEvent(payload);
      await request(`track/${order.token}/pay`, {}, undefined, 409);
      assert.equal(await store.paymentAttempt.count({ where: { orderId: order.id } }), 1);
      const tracked = await request('track/' + order.token);
      assert.equal(tracked.payment.state, 'REVIEW');
      assert.equal(tracked.payment.payUrl, null);
      await request('manage/reviews/' + payload.id, { resolution: 'Đã đối chiếu và hoàn khoản chuyển thiếu cho khách' }, 'OWNER');
      const next = await beginPayment(order.id);
      assert.notEqual(next.id, attempt.id);
    });
    await check('Webhook đến trước phản hồi tạo QR giữ trạng thái cần đối soát', async () => {
      const order = await transfer();
      nextCreate = 'review-race';
      beforeCreateResponse = async remote => {
        await applyBankEvent({ id: randomUUID(), type: 'payment.succeeded', data: { order_id: remote.id, transaction_id: randomUUID(), amount_vnd: Number(remote.amount_vnd) - 1, metadata: remote.metadata } });
      };
      const attempt = await beginPayment(order.id);
      assert.equal(attempt.state, 'REVIEW');
      assert.equal(attempt.externalId, [...remotes.values()].find(remote => (remote.metadata as { order_internal_id: string }).order_internal_id === order.id)?.id);
      assert.ok(attempt.lastError);
    });
    await check('Webhook đến sớm không có metadata được ghép khi createRemote nhận externalId', async () => {
      const order = await transfer();
      let payload!: ReturnType<typeof event>;
      nextCreate = 'review-race';
      beforeCreateResponse = async remote => {
        payload = event({ externalId: String(remote.id), amount: Number(remote.amount_vnd) });
        assert.equal(await applyBankEvent(payload), 'REVIEW');
        assert.match((await store.bankEvent.findUniqueOrThrow({ where: { id: payload.id } })).reason ?? '', /Không tìm thấy yêu cầu/);
      };
      const attempt = await beginPayment(order.id);
      assert.equal(attempt.state, 'PAID');
      assert.deepEqual(await Promise.all([applyBankEvent(payload), applyBankEvent({ ...payload, id: randomUUID() })]), ['APPLIED', 'APPLIED']);
      const current = await getOrder(order.id);
      assert.equal(current.paymentStatus, 'PAID');
      assert.ok(current.queuedAt);
      assert.equal(current.records.length, 1);
      assert.equal((await store.bankEvent.findUniqueOrThrow({ where: { id: payload.id } })).state, 'APPLIED');
    });
    await check('Worker ghép webhook chưa có attempt, không ghi tiền hai lần', async () => {
      const order = await transfer();
      const attempt = await beginPayment(order.id);
      await store.paymentAttempt.update({ where: { id: attempt.id }, data: { externalId: null } });
      const payload = event(attempt);
      assert.equal(await applyBankEvent(payload), 'REVIEW');
      await store.paymentAttempt.update({ where: { id: attempt.id }, data: { externalId: attempt.externalId, nextPollAt: new Date(0) } });
      Object.assign(remotes.get(attempt.externalId!)!, { status: 'paid', paid_tx_id: payload.data.transaction_id, paid_at: payload.data.posted_at });
      await paymentWorkerTick();
      assert.equal((await getOrder(order.id)).paymentStatus, 'PAID');
      assert.deepEqual(await Promise.all([applyBankEvent(payload), applyBankEvent(payload)]), ['APPLIED', 'APPLIED']);
      assert.equal(await applyBankEvent({ ...payload, id: randomUUID() }), 'APPLIED');
      assert.equal((await getOrder(order.id)).records.length, 1);
      assert.equal((await store.bankEvent.findUniqueOrThrow({ where: { id: payload.id } })).state, 'APPLIED');
      assert.equal(await store.bankEvent.count({ where: { transactionId: payload.data.transaction_id } }), 1);
    });
    await check('Ghép webhook vẫn kiểm tra số tiền và giữ bằng chứng cũ khi gửi lại', async () => {
      const order = await transfer();
      let payload!: ReturnType<typeof event>;
      nextCreate = 'review-race';
      beforeCreateResponse = async remote => {
        payload = event({ externalId: String(remote.id), amount: Number(remote.amount_vnd) - 1 });
        assert.equal(await applyBankEvent(payload), 'REVIEW');
      };
      const attempt = await beginPayment(order.id);
      assert.equal(attempt.state, 'REVIEW');
      const saved = await store.bankEvent.findUniqueOrThrow({ where: { id: payload.id } });
      assert.match(saved.reason ?? '', /Số tiền không khớp/);
      assert.equal(await applyBankEvent({ ...payload, data: { ...payload.data, amount_vnd: attempt.amount } }), 'REVIEW');
      assert.equal((await getOrder(order.id)).records.length, 0);
      await request('manage/reviews/' + payload.id, { resolution: 'Đã hoàn khoản chuyển thiếu' }, 'OWNER');
      assert.equal(await applyBankEvent(payload), 'RESOLVED');
    });
    await check('QR PENDING quá hạn trả 410 và không được tái sử dụng', async () => {
      const order = await transfer();
      const attempt = await beginPayment(order.id);
      await store.paymentAttempt.update({ where: { id: attempt.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await request('payment-qr/' + attempt.id + '?token=' + order.token, undefined, undefined, 410);
      const next = await beginPayment(order.id);
      assert.notEqual(next.id, attempt.id);
      assert.equal((await store.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).state, 'EXPIRED');
    });
    await check('APIBank trả yêu cầu đã hủy không hiển thị QR còn hiệu lực', async () => {
      const order = await transfer();
      nextCreate = 'cancelled';
      assert.equal((await beginPayment(order.id)).state, 'CANCELLED');
    });
    await check('APIBank đang kiểm tra: ẩn QR, tái dùng yêu cầu và tiếp tục đối soát', async () => {
      const order = await transfer();
      nextCreate = 'review';
      const attempt = await beginPayment(order.id);
      assert.equal(attempt.state, 'VERIFYING');
      assert.equal((await beginPayment(order.id)).id, attempt.id);
      const tracked = await request('track/' + order.token);
      assert.equal(tracked.payment.state, 'VERIFYING');
      assert.equal(tracked.payment.payUrl, null);
      const remote = remotes.get(attempt.externalId!)!;
      Object.assign(remote, { status: 'paid', paid_tx_id: randomUUID(), paid_at: new Date().toISOString() });
      await store.paymentAttempt.update({ where: { id: attempt.id }, data: { nextPollAt: new Date(0) } });
      await paymentWorkerTick();
      assert.equal((await getOrder(order.id)).paymentStatus, 'PAID');
    });
    await check('Tiền vào QR cũ đã hủy sau mở lại đơn cần đối soát', async () => {
      const order = await transfer();
      const attempt = await beginPayment(order.id);
      await cancelActivePayments(order.id);
      const current = await getOrder(order.id);
      const reopened = await orderAction(current.id, current.version, 'reopen', actors.OWNER, 'Đổi món');
      await confirmOrder(reopened.id, reopened.version, actors.OWNER, 800, 0);
      assert.equal(await applyBankEvent(event(attempt)), 'REVIEW');
      assert.equal(await applyBankEvent(event(attempt)), 'REVIEW');
      assert.equal((await getOrder(order.id)).paymentStatus, 'UNPAID');
    });
    await check('Worker đối soát giao dịch đã trả tiền', async () => {
      const order = await transfer();
      const attempt = await beginPayment(order.id);
      const remote = remotes.get(attempt.externalId!)!;
      Object.assign(remote, { status: 'paid', paid_tx_id: randomUUID(), paid_at: new Date().toISOString() });
      await store.paymentAttempt.update({ where: { id: attempt.id }, data: { nextPollAt: new Date(0) } });
      await paymentWorkerTick();
      assert.equal((await getOrder(order.id)).paymentStatus, 'PAID');
    });
    await check('Worker giữ lý do đối soát khi tiền đến sau hạn QR', async () => {
      const order = await transfer();
      const attempt = await beginPayment(order.id);
      const remote = remotes.get(attempt.externalId!)!;
      Object.assign(remote, { status: 'paid', paid_tx_id: randomUUID(), paid_at: new Date().toISOString() });
      await store.paymentAttempt.update({ where: { id: attempt.id }, data: { expiresAt: new Date(Date.now() - 1000), nextPollAt: new Date(0) } });
      await paymentWorkerTick();
      const current = await store.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      assert.equal(current.state, 'REVIEW');
      assert.match(current.lastError ?? '', /hết hạn/);
      assert.equal((await getOrder(order.id)).paymentStatus, 'UNPAID');
    });
    await check('Chỉ chủ quán được hủy đơn đã thu và hoàn tiền đúng một lần', async () => {
      let order = await action(await create(), 'confirm', { taxBps: 800, shipping: 0 });
      order = await action(order, 'manual-pay', { note: 'Đã nhận đủ' });
      await request(`orders/${order.id}/cancel`, { version: order.version, note: 'Khách hủy' }, 'CASHIER', 403);
      order = await action(order, 'cancel', { note: 'Khách hủy' }, 'OWNER');
      order = await action(order, 'refund', { note: 'Đã trả lại khách' }, 'OWNER');
      await request(`orders/${order.id}/refund`, { version: order.version, note: 'Thử lại' }, 'OWNER', 409);
      assert.equal(order.paymentStatus, 'REFUNDED');
      assert.equal(order.records.filter(record => record.kind === 'REFUND').length, 1);
    });
    const tableBody={name:'Bàn kiểm thử 01',area:'Tầng trệt',seats:4,active:true};
    let table:Awaited<ReturnType<typeof store.diningTable.create>>;
    let visitToken='';
    let tableOrder:OrderView;
    await check('Chỉ chủ quán tạo/sửa bàn; nhân viên bếp không xem quản lý bàn', async()=>{
      await request('tables',tableBody,undefined,401);
      await request('tables',tableBody,'CASHIER',403);
      await request('tables',undefined,'KITCHEN',403);
      table=await request('tables',tableBody,'OWNER',201);
      assert.match(table.qrToken,/^[A-Za-z0-9_-]{32}$/);
      await request('tables',tableBody,'OWNER',409);
      const listed=await request('tables',undefined,'CASHIER');
      assert.equal(listed[0].qrUrl,process.env.APP_URL+'/t/'+table.qrToken);
    });
    await check('Khách quét QR đồng thời cùng vào một lượt phục vụ',async()=>{
      const publicInfo=await request('table/'+table.qrToken);
      assert.equal(publicInfo.name,table.name);
      assert.equal('visits' in publicInfo,false);
      const [a,b]=await Promise.all([request('table/'+table.qrToken+'/open',{}),request('table/'+table.qrToken+'/open',{})]);
      assert.equal(a.token,b.token);visitToken=a.token;
      assert.equal(await store.tableVisit.count({where:{tableId:table.id}}),1);
      await request('table-visits/'+visitToken+'/bill',{},undefined,409);
    });
    await check('QR tạo được ảnh SVG; chỉ nhân viên được tải/in',async()=>{
      const context={params:Promise.resolve({path:['tables',table.id,'qr']})};
      const url=process.env.APP_URL+'/api/tables/'+table.id+'/qr?download=1';
      const denied=await GET(new Request(url),context);assert.equal(denied.status,401);
      const response=await GET(new Request(url,{headers:{Cookie:sessions.OWNER}}),context);
      assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/svg+xml');
      assert.match(response.headers.get('content-disposition')??'',/attachment/);
      assert.match(await response.text(),/<svg[^>]+viewBox/);
    });
    await check('Gọi món qua QR gắn đúng bàn và không tin tên bàn từ khách',async()=>{
      const created=await request('orders',input({type:'DINE_IN',tableName:'Bàn giả',tableVisitToken:visitToken,customerName:'Thông tin riêng',phone:'0901234567'}),undefined,201);
      tableOrder=await request('orders/'+created.id,undefined,'OWNER');
      assert.equal(tableOrder.tableName,table.name);assert.equal(tableOrder.source,'TABLE_QR');
      assert.ok(tableOrder.tableVisitId);assert.equal(tableOrder.tableVisit?.token,visitToken);
      await request('orders',input({tableVisitToken:visitToken}),undefined,400);
      await request(`orders/${tableOrder.id}/edit`,{version:tableOrder.version,order:input()},'CASHIER',409);
      const publicData=await request('table-visits/'+visitToken);
      assert.equal(publicData.orders.length,1);assert.equal(publicData.total,tableOrder.total);
      for(const key of ['token','phone','customerName','address','payment','records','id'])assert.equal(key in publicData.orders[0],false);
      const tracked=await request('track/'+tableOrder.token);assert.equal(tracked.tableVisit.token,visitToken);
      assert.ok(!JSON.stringify(tracked).includes(table.qrToken));
    });
    await check('Gọi thêm món cùng bàn; hai yêu cầu thanh toán chỉ ghi một lần',async()=>{
      await request('orders',input({type:'DINE_IN',tableVisitToken:visitToken}),undefined,201);
      const [a,b]=await Promise.all([request('table-visits/'+visitToken+'/bill',{}),request('table-visits/'+visitToken+'/bill',{})]);
      assert.equal(a.requestedAt,b.requestedAt);
      const visit=await store.tableVisit.findUniqueOrThrow({where:{token:visitToken}});assert.equal(visit.version,1);
      assert.equal((await request('table-alerts',undefined,'CASHIER')).pending,1);
      const publicData=await request('table-visits/'+visitToken);assert.equal(publicData.orders.length,2);
      assert.equal(publicData.unpaid,publicData.total);
      assert.equal((await getOrder(tableOrder.id)).paymentStatus,'UNPAID');
      await request('orders',input({type:'DINE_IN',tableVisitToken:visitToken}),undefined,409);
    });
    await check('Thu ngân tiếp nhận, mở lại gọi món; chưa thu đủ không thể đóng bàn',async()=>{
      let visit=await store.tableVisit.findUniqueOrThrow({where:{token:visitToken}});
      await request('table-visits/'+visit.id+'/close',{version:visit.version},'CASHIER',409);
      await request('tables/'+table.id,{...tableBody,active:false,version:table.version},'OWNER',409);
      await request('tables/'+table.id+'/rotate',{version:table.version},'OWNER',409);
      await request('table-visits/'+visit.id+'/acknowledge',{version:visit.version},'KITCHEN',403);
      visit=await request('table-visits/'+visit.id+'/acknowledge',{version:visit.version},'CASHIER');
      assert.ok(visit.billAcknowledgedAt);assert.equal((await request('table-alerts',undefined,'OWNER')).pending,0);
      await request('table-visits/'+visit.id+'/resume',{version:0},'CASHIER',409);
      visit=await request('table-visits/'+visit.id+'/resume',{version:visit.version},'CASHIER');
      assert.equal(visit.billRequestedAt,null);
      await request('orders',input({type:'DINE_IN',tableVisitToken:visitToken}),undefined,201);
    });
    await check('Quét lại cùng QR mở lượt mới; liên kết lượt cũ không gọi món hoặc thanh toán được',async()=>{
      const visit=await store.tableVisit.findUniqueOrThrow({where:{token:visitToken}});
      const orders=await store.order.findMany({where:{tableVisitId:visit.id}});
      for(const original of orders){
        let current=await action(original,'confirm',{taxBps:0,shipping:0});
        current=await action(current,'start',{},'OWNER');current=await action(current,'ready',{},'OWNER');
        current=await action(current,'complete');current=await action(current,'manual-pay',{note:'Thu tiền bàn kiểm thử'});
      }
      const closed=await request('table-visits/'+visit.id+'/close',{version:visit.version},'CASHIER');assert.ok(closed.closedAt);
      await request('orders',input({type:'DINE_IN',tableVisitToken:visitToken}),undefined,409);
      await request('table-visits/'+visitToken+'/bill',{},undefined,409);
      const next=await request('table/'+table.qrToken+'/open',{});assert.notEqual(next.token,visitToken);
      assert.equal((await request('table-visits/'+next.token)).orders.length,0);
      const oldVisit=await request('table-visits/'+visitToken);
      assert.ok(oldVisit.closedAt);
      assert.equal(oldVisit.orders.length,0);
      const nextVisit=await store.tableVisit.findUniqueOrThrow({where:{token:next.token}});
      assert.equal((await getTableBillVisit(table.id))?.id, nextVisit.id);
      const closedBill = await getTableBillVisit(table.id, visit.id);
      assert.equal(closedBill?.id, visit.id);
      assert.deepEqual(closedBill.orders.map(order => order.id).sort(), orders.map(order => order.id).sort());
      assert.equal(await getTableBillVisit(table.id, 'unknown-visit'), null);
      assert.equal(await getTableBillVisit('different-table', visit.id), null);
      await request('table-visits/'+nextVisit.id+'/close',{version:nextVisit.version},'CASHIER');
    });
    await check('Đổi QR vô hiệu mã cũ; tạm ngưng bàn chặn mở lượt khách',async()=>{
      const oldToken=table.qrToken;
      table=await request('tables/'+table.id+'/rotate',{version:table.version},'OWNER');
      assert.notEqual(table.qrToken,oldToken);
      const oldTracking=await request('track/'+tableOrder.token);
      assert.equal(oldTracking.tableVisit.token,visitToken);
      assert.ok(oldTracking.tableVisit.closedAt);
      assert.ok(!JSON.stringify(oldTracking).includes(table.qrToken));
      await request('table/'+oldToken,undefined,undefined,404);
      await request('table/'+oldToken+'/open',{},undefined,404);
      await request('tables/'+table.id,{...tableBody,active:false,version:table.version},'OWNER');
      await request('table/'+table.qrToken+'/open',{},undefined,404);
    });
    await check('Không đóng lượt còn giao dịch REVIEW kể cả đơn đã hủy/đã hoàn tất', async () => {
      for (const status of ['CANCELLED', 'COMPLETED']) {
        const table = await request('tables', { name: 'Đối soát ' + status, area: 'Kiểm thử', seats: 4, active: true }, 'OWNER', 201);
        const { token } = await request('table/' + table.qrToken + '/open', {});
        let order = await create({ type: 'DINE_IN', tableVisitToken: token, paymentMethod: 'TRANSFER' });
        order = await action(order, 'confirm', { taxBps: 0, shipping: 0 });
        const attempt = await beginPayment(order.id);
        const payload = event(attempt, { amount_vnd: attempt.amount - 1 });
        assert.equal(await applyBankEvent(payload), 'REVIEW');
        order = await request('orders/' + order.id, undefined, 'OWNER');
        if (status === 'CANCELLED') order = await action(order, 'cancel', { note: 'Khách hủy, đang đối soát khoản chuyển thiếu' }, 'OWNER');
        else {
          order = await action(order, 'manual-pay', { note: 'Đã thu đủ tiền mặt, khoản chuyển thiếu chờ hoàn' });
          order = await action(order, 'start', {}, 'OWNER');
          order = await action(order, 'ready', {}, 'OWNER');
          order = await action(order, 'complete');
        }
        assert.equal(order.status, status);
        const visit = await store.tableVisit.findUniqueOrThrow({ where: { token } });
        const denied = await request('table-visits/' + visit.id + '/close', { version: visit.version }, 'CASHIER', 409);
        assert.match(denied.error, /đối soát/);
        assert.equal((await store.tableVisit.findUniqueOrThrow({ where: { id: visit.id } })).closedAt, null);
        await request('manage/reviews/' + payload.id, { resolution: 'Đã đối soát và hoàn khoản chuyển thiếu' }, 'OWNER');
        assert.ok((await request('table-visits/' + visit.id + '/close', { version: visit.version }, 'CASHIER')).closedAt);
      }
    });
    await check('Theo dõi giới hạn 60/phút/token, chia sẻ IP không khóa đơn khác', async () => {
      const first = await create();const second = await create();const now = Date.now;const fixed = now();Date.now = () => fixed;
      try {
        for (let index = 0; index < 60; index++) await request('track/' + first.token, undefined, undefined, 200, '198.51.100.20');
        await request('track/' + first.token, undefined, undefined, 429, '198.51.100.21');
        await request('track/' + second.token, undefined, undefined, 200, '198.51.100.20');
      } finally { Date.now = now; }
    });
    await check('Nhiều bàn chung Wi-Fi cập nhật trạng thái mà không chặn lẫn nhau',async()=>{
      const tokens:string[]=[];
      for(let index=0;index<11;index++){
        const created=await request('tables',{name:'Wi-Fi '+index,area:'Kiểm thử',seats:4,active:true},'OWNER',201);
        tokens.push((await request('table/'+created.qrToken+'/open',{})).token);
      }
      const now=Date.now;const fixed=now();Date.now=()=>fixed;
      try{
        // Eleven phones polling every five seconds share one public IP.
        for(let tick=0;tick<12;tick++)for(const token of tokens){
          await request('table-visits/'+token,undefined,undefined,200,'198.51.100.10');
        }
      }finally{Date.now=now;}
    });
    await check('Giới hạn theo lượt khách vẫn chặn gọi quá nhanh và không khóa bàn khác',async()=>{
      const active=await store.tableVisit.findMany({where:{closedAt:null},take:2});
      assert.equal(active.length,2);
      const now=Date.now;const fixed=now();Date.now=()=>fixed;
      try{
        for(let index=0;index<360;index++)await request('table-visits/'+active[0].token,undefined,undefined,200,'198.51.100.11');
        await request('table-visits/'+active[0].token,undefined,undefined,429,'198.51.100.11');
        await request('table-visits/'+active[1].token,undefined,undefined,200,'198.51.100.11');
      }finally{Date.now=now;}
    });
    console.log(`\nIntegration: ${passed} passed, ${failed} failed. Temporary database: ${database}`);
    if (failed) process.exitCode = 1;
  } finally {
    await db?.$disconnect();
    if (bank.listening) await new Promise<void>((resolve, reject) => bank.close(error => error ? reject(error) : resolve()));
    try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
    finally { await admin.end(); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
