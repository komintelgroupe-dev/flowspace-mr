"""FlowSpace MR V5.1 — local production database and API.

Development backend only. Run on 127.0.0.1, not on the public internet.
All material quantities use thousandths of their declared unit to avoid
floating-point stock drift. Finished products and orders are whole pieces.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Iterator

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

DB_PATH = Path(os.environ.get('FLOWSPACE_DB_PATH', Path(__file__).parent / 'data' / 'flowspace.db'))


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def quantity_milli(value: Decimal) -> int:
    """Convert positive quantity to exact thousandths; don't silently round."""
    scaled = value * 1000
    if not value.is_finite() or value <= 0 or scaled != scaled.to_integral_value():
        raise HTTPException(422, 'Quantity must be positive with at most 3 decimal places')
    if scaled > 1_000_000_000_000:
        raise HTTPException(422, 'Quantity is too large')
    return int(scaled)


def display_quantity(milli: int) -> float:
    return milli / 1000


def not_found(thing: str) -> HTTPException:
    return HTTPException(404, f'{thing} not found')


@contextmanager
def connect(*, write: bool = False) -> Iterator[sqlite3.Connection]:
    con = sqlite3.connect(str(DB_PATH), timeout=15, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys = ON')
    try:
        if write:
            con.execute('BEGIN IMMEDIATE')
        yield con
        if write:
            con.execute('COMMIT')
    except Exception:
        if write:
            con.execute('ROLLBACK')
        raise
    finally:
        con.close()


def setup_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as con:
        con.executescript('''
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY,
                sku TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT 'pcs',
                finished_qty INTEGER NOT NULL DEFAULT 0 CHECK(finished_qty >= 0),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS materials (
                id INTEGER PRIMARY KEY,
                sku TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT 'kg',
                stock_milli INTEGER NOT NULL DEFAULT 0 CHECK(stock_milli >= 0),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bom_items (
                product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
                qty_per_unit_milli INTEGER NOT NULL CHECK(qty_per_unit_milli > 0),
                PRIMARY KEY(product_id, material_id)
            );
            CREATE TABLE IF NOT EXISTS production_orders (
                id INTEGER PRIMARY KEY,
                product_id INTEGER NOT NULL REFERENCES products(id),
                quantity INTEGER NOT NULL CHECK(quantity > 0),
                status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','completed','cancelled')),
                created_at TEXT NOT NULL,
                completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS stock_movements (
                id INTEGER PRIMARY KEY,
                item_type TEXT NOT NULL CHECK(item_type IN ('material','product')),
                item_id INTEGER NOT NULL,
                delta_milli INTEGER NOT NULL,
                reason TEXT NOT NULL,
                order_id INTEGER REFERENCES production_orders(id),
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_stock_order ON stock_movements(order_id);
            CREATE INDEX IF NOT EXISTS idx_order_status ON production_orders(status);
            PRAGMA user_version = 1;
        ''')


class NamedItem(BaseModel):
    sku: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=120)

    @field_validator('sku', 'name')
    @classmethod
    def no_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError('Cannot be blank')
        return value


class ProductCreate(NamedItem):
    unit: str = Field(default='pcs', min_length=1, max_length=16)


class MaterialCreate(NamedItem):
    unit: str = Field(default='kg', min_length=1, max_length=16)
    opening_stock: Decimal = Field(default=Decimal('0'), ge=0)


class ReceiveStock(BaseModel):
    quantity: Decimal = Field(gt=0)
    note: str = Field(default='stock receipt', max_length=100)


class BOMItem(BaseModel):
    material_id: int = Field(gt=0)
    quantity_per_product: Decimal = Field(gt=0)


class BOMReplace(BaseModel):
    items: list[BOMItem] = Field(min_length=1)


class OrderCreate(BaseModel):
    product_id: int = Field(gt=0)
    quantity: int = Field(gt=0, le=1_000_000)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    setup_database()
    yield


app = FastAPI(
    title='FlowSpace MR — Production API',
    version='5.1.0',
    description='Local SQLite-backed production demonstration. No authentication; bind only to localhost.',
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        'https://localhost:8081', 'http://localhost:8081',
        'https://127.0.0.1:8081', 'http://127.0.0.1:8081',
        'http://localhost:5173', 'https://localhost:5173',
    ],
    allow_methods=['GET', 'POST'],
    allow_headers=['Content-Type'],
)


@app.get('/health')
def health():
    return {'status': 'ok', 'app': 'FlowSpace MR', 'version': '5.1.0'}


@app.post('/api/products', status_code=201)
def create_product(data: ProductCreate):
    try:
        with connect(write=True) as con:
            cur = con.execute(
                'INSERT INTO products(sku,name,unit,created_at) VALUES(?,?,?,?)',
                (data.sku.upper(), data.name, data.unit.strip(), timestamp()),
            )
            row = con.execute('SELECT * FROM products WHERE id=?', (cur.lastrowid,)).fetchone()
            return {**dict(row), 'finished_stock': row['finished_qty']}
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, 'Product SKU already exists') from exc


@app.get('/api/products')
def list_products():
    with connect() as con:
        rows = con.execute('SELECT * FROM products ORDER BY id').fetchall()
        return [{**dict(r), 'finished_stock': r['finished_qty']} for r in rows]


@app.post('/api/materials', status_code=201)
def create_material(data: MaterialCreate):
    opening = 0 if data.opening_stock == 0 else quantity_milli(data.opening_stock)
    try:
        with connect(write=True) as con:
            cur = con.execute(
                'INSERT INTO materials(sku,name,unit,stock_milli,created_at) VALUES(?,?,?,?,?)',
                (data.sku.upper(), data.name, data.unit.strip(), opening, timestamp()),
            )
            if opening:
                con.execute('''INSERT INTO stock_movements(item_type,item_id,delta_milli,reason,created_at)
                               VALUES('material',?,?,?,?)''',
                            (cur.lastrowid, opening, 'opening stock', timestamp()))
            row = con.execute('SELECT * FROM materials WHERE id=?', (cur.lastrowid,)).fetchone()
            return material_dict(row)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, 'Material SKU already exists') from exc


def material_dict(row: sqlite3.Row) -> dict:
    return {'id': row['id'], 'sku': row['sku'], 'name': row['name'],
            'unit': row['unit'], 'stock': display_quantity(row['stock_milli']),
            'created_at': row['created_at']}


@app.get('/api/materials')
def list_materials():
    with connect() as con:
        return [material_dict(r) for r in con.execute('SELECT * FROM materials ORDER BY id')]


@app.post('/api/materials/{material_id}/receive')
def receive_stock(material_id: int, data: ReceiveStock):
    amount = quantity_milli(data.quantity)
    with connect(write=True) as con:
        row = con.execute('SELECT * FROM materials WHERE id=?', (material_id,)).fetchone()
        if row is None:
            raise not_found('Material')
        con.execute('UPDATE materials SET stock_milli=stock_milli+? WHERE id=?', (amount, material_id))
        con.execute('''INSERT INTO stock_movements(item_type,item_id,delta_milli,reason,created_at)
                       VALUES('material',?,?,?,?)''', (material_id, amount, data.note.strip() or 'stock receipt', timestamp()))
        return material_dict(con.execute('SELECT * FROM materials WHERE id=?', (material_id,)).fetchone())


@app.put('/api/products/{product_id}/bom')
def replace_bom(product_id: int, data: BOMReplace):
    if len({i.material_id for i in data.items}) != len(data.items):
        raise HTTPException(422, 'Duplicate material in BOM')
    quantities = [(i.material_id, quantity_milli(i.quantity_per_product)) for i in data.items]
    with connect(write=True) as con:
        if not con.execute('SELECT 1 FROM products WHERE id=?', (product_id,)).fetchone():
            raise not_found('Product')
        for mid, _ in quantities:
            if not con.execute('SELECT 1 FROM materials WHERE id=?', (mid,)).fetchone():
                raise not_found(f'Material {mid}')
        con.execute('DELETE FROM bom_items WHERE product_id=?', (product_id,))
        con.executemany('INSERT INTO bom_items(product_id,material_id,qty_per_unit_milli) VALUES(?,?,?)',
                        [(product_id, mid, amt) for mid, amt in quantities])
    return get_bom(product_id)


@app.get('/api/products/{product_id}/bom')
def get_bom(product_id: int):
    with connect() as con:
        product = con.execute('SELECT id,sku,name FROM products WHERE id=?', (product_id,)).fetchone()
        if product is None:
            raise not_found('Product')
        rows = con.execute('''SELECT b.material_id,m.sku,m.name,m.unit,b.qty_per_unit_milli
                              FROM bom_items b JOIN materials m ON b.material_id=m.id
                              WHERE b.product_id=? ORDER BY b.material_id''', (product_id,)).fetchall()
        return {'product': dict(product), 'items': [
            {'material_id': r['material_id'], 'sku': r['sku'], 'name': r['name'],
             'unit': r['unit'], 'quantity_per_product': display_quantity(r['qty_per_unit_milli'])}
            for r in rows]}


@app.post('/api/orders', status_code=201)
def create_order(data: OrderCreate):
    with connect(write=True) as con:
        if not con.execute('SELECT 1 FROM products WHERE id=?', (data.product_id,)).fetchone():
            raise not_found('Product')
        cur = con.execute('INSERT INTO production_orders(product_id,quantity,created_at) VALUES(?,?,?)',
                          (data.product_id, data.quantity, timestamp()))
        return dict(con.execute('SELECT * FROM production_orders WHERE id=?', (cur.lastrowid,)).fetchone())


@app.get('/api/orders')
def list_orders(status: str | None = Query(default=None, pattern='^(draft|completed|cancelled)$')):
    with connect() as con:
        if status:
            rows = con.execute('SELECT * FROM production_orders WHERE status=? ORDER BY id DESC', (status,))
        else:
            rows = con.execute('SELECT * FROM production_orders ORDER BY id DESC')
        return [dict(r) for r in rows]


def requirements(con: sqlite3.Connection, order: sqlite3.Row) -> list[dict]:
    rows = con.execute('''SELECT m.id,m.name,m.sku,m.unit,m.stock_milli,b.qty_per_unit_milli
                          FROM bom_items b JOIN materials m ON m.id=b.material_id
                          WHERE b.product_id=? ORDER BY m.id''', (order['product_id'],)).fetchall()
    return [{
        'material_id': r['id'], 'sku': r['sku'], 'name': r['name'], 'unit': r['unit'],
        'required': display_quantity(r['qty_per_unit_milli'] * order['quantity']),
        'available': display_quantity(r['stock_milli']),
        'sufficient': r['stock_milli'] >= r['qty_per_unit_milli'] * order['quantity'],
        '_required_milli': r['qty_per_unit_milli'] * order['quantity'],
    } for r in rows]


@app.get('/api/orders/{order_id}/requirements')
def order_requirements(order_id: int):
    with connect() as con:
        order = con.execute('SELECT * FROM production_orders WHERE id=?', (order_id,)).fetchone()
        if order is None:
            raise not_found('Order')
        req = requirements(con, order)
        return {'order': dict(order), 'bom_configured': bool(req),
                'can_complete': order['status'] == 'draft' and bool(req) and all(r['sufficient'] for r in req),
                'requirements': [{k:v for k,v in r.items() if not k.startswith('_')} for r in req]}


@app.post('/api/orders/{order_id}/complete')
def complete_order(order_id: int):
    """Atomically consume materials and produce finished pieces, or do nothing."""
    with connect(write=True) as con:
        order = con.execute('SELECT * FROM production_orders WHERE id=?', (order_id,)).fetchone()
        if order is None:
            raise not_found('Order')
        if order['status'] != 'draft':
            raise HTTPException(409, f'Order already {order["status"]}')
        req = requirements(con, order)
        if not req:
            raise HTTPException(409, 'Product has no BOM; configure its recipe first')
        missing = [r['sku'] for r in req if not r['sufficient']]
        if missing:
            raise HTTPException(409, {'message': 'Insufficient raw materials', 'materials': missing})
        for r in req:
            con.execute('UPDATE materials SET stock_milli=stock_milli-? WHERE id=?',
                        (r['_required_milli'], r['material_id']))
            con.execute('''INSERT INTO stock_movements
                (item_type,item_id,delta_milli,reason,order_id,created_at)
                VALUES('material',?,?,'production consumption',?,?)''',
                (r['material_id'], -r['_required_milli'], order_id, timestamp()))
        con.execute('UPDATE products SET finished_qty=finished_qty+? WHERE id=?',
                    (order['quantity'], order['product_id']))
        con.execute('''INSERT INTO stock_movements
            (item_type,item_id,delta_milli,reason,order_id,created_at)
            VALUES('product',?,?,'finished production',?,?)''',
            (order['product_id'], order['quantity'] * 1000, order_id, timestamp()))
        con.execute("UPDATE production_orders SET status='completed',completed_at=? WHERE id=?",
                    (timestamp(), order_id))
        return dict(con.execute('SELECT * FROM production_orders WHERE id=?', (order_id,)).fetchone())


@app.post('/api/orders/{order_id}/cancel')
def cancel_order(order_id: int):
    with connect(write=True) as con:
        row = con.execute('SELECT * FROM production_orders WHERE id=?', (order_id,)).fetchone()
        if row is None:
            raise not_found('Order')
        if row['status'] != 'draft':
            raise HTTPException(409, 'Only draft orders can be cancelled')
        con.execute("UPDATE production_orders SET status='cancelled' WHERE id=?", (order_id,))
        return dict(con.execute('SELECT * FROM production_orders WHERE id=?', (order_id,)).fetchone())


@app.get('/api/movements')
def list_movements(limit: int = Query(default=100, ge=1, le=500)):
    with connect() as con:
        rows = con.execute('SELECT * FROM stock_movements ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
        return [{**dict(r), 'quantity_change': display_quantity(r['delta_milli'])} for r in rows]


@app.get('/api/overview')
def overview():
    with connect() as con:
        return {
            'products': con.execute('SELECT COUNT(*) FROM products').fetchone()[0],
            'materials': con.execute('SELECT COUNT(*) FROM materials').fetchone()[0],
            'orders_draft': con.execute("SELECT COUNT(*) FROM production_orders WHERE status='draft'").fetchone()[0],
            'orders_completed': con.execute("SELECT COUNT(*) FROM production_orders WHERE status='completed'").fetchone()[0],
            'finished_pieces': con.execute('SELECT COALESCE(SUM(finished_qty),0) FROM products').fetchone()[0],
        }


@app.get('/panel', include_in_schema=False)
def panel():
    return FileResponse(Path(__file__).with_name('panel.html'))
