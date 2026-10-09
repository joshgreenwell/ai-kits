import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetiredDatabaseHost } from '../lib/database-host';

test('the retired Supabase hosts are refused and Aurora and local hosts are not', () => {
  assert.equal(isRetiredDatabaseHost('postgresql://personal_hub_app:x@aws-0-us-east-2.pooler.supabase.com:6543/postgres'), true);
  assert.equal(isRetiredDatabaseHost('postgresql://postgres:x@db.abcdefghijklmnopqrst.SUPABASE.co:5432/postgres'), true);
  assert.equal(isRetiredDatabaseHost('postgresql://personal_hub_app:a%25b@aws-0-us-east-2.pooler.supabase.com/postgres?sslmode=require'), true);
  assert.equal(isRetiredDatabaseHost('postgresql://personal_hub_app:x@cluster.cluster-abc.us-east-1.rds.amazonaws.com:5432/ai_kits?sslmode=require'), false);
  assert.equal(isRetiredDatabaseHost('postgres://localhost/personal_hub_test'), false);
  assert.equal(isRetiredDatabaseHost('postgresql://u:x@notsupabase.company.test/db'), false);
});

test('an unparseable URL is refused when it names Supabase', () => {
  assert.equal(isRetiredDatabaseHost('postgresql://u:pa/ss@aws-0-us-east-2.pooler.supabase.com/postgres'), true);
  assert.equal(isRetiredDatabaseHost('postgresql://u:pa/ss@localhost/postgres'), false);
});
