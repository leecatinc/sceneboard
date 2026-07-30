local operation = ARGV[1]
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return {'missing'} end
local now = tonumber(ARGV[2])
local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAtMs'))
if not now or not expiresAt or now >= expiresAt then
  redis.call('DEL', KEYS[1])
  return {'expired'}
end

if operation == 'reject' then
  redis.call('DEL', KEYS[1])
  return {'rejected'}
end

if operation == 'claim' then
  if redis.call('HGET', KEYS[1], 'tokenHmac') ~= ARGV[4] then
    redis.call('DEL', KEYS[1])
    return {'token'}
  end
  if state ~= 'open' then return {'state'} end
  local nonce = ARGV[3]
  redis.call('HSET', KEYS[1], 'state', 'claimed', 'claimNonce', nonce)
  redis.call('EXPIRE', KEYS[1], 60)
  return {'claimed', nonce}
end

local claimNonce = redis.call('HGET', KEYS[1], 'claimNonce')
if state ~= 'claimed' or not claimNonce or claimNonce ~= ARGV[3] then return {'claim'} end

if operation == 'renew' then
  redis.call('EXPIRE', KEYS[1], 60)
  return {'renewed'}
end

if operation == 'debit' then
  local counter = ARGV[4]
  local byteCounter = ARGV[5]
  local maximumCount = tonumber(ARGV[6])
  local maximumBytes = tonumber(ARGV[7])
  local amount = tonumber(ARGV[8])
  if not maximumCount or not maximumBytes or not amount or amount < 0 then
    redis.call('DEL', KEYS[1])
    return {'invalid'}
  end
  local nextCount = tonumber(redis.call('HGET', KEYS[1], counter)) + 1
  local nextBytes = tonumber(redis.call('HGET', KEYS[1], byteCounter)) + amount
  if nextCount > maximumCount or nextBytes > maximumBytes then
    redis.call('DEL', KEYS[1])
    return {'budget_exceeded'}
  end
  redis.call('HSET', KEYS[1], counter, nextCount, byteCounter, nextBytes)
  return {'debited', tostring(nextCount), tostring(nextBytes)}
end

if operation == 'close' then
  redis.call('HSET', KEYS[1], 'state', 'closed')
  redis.call('DEL', KEYS[1])
  return {'closed'}
end

redis.call('DEL', KEYS[1])
return {'invalid'}
