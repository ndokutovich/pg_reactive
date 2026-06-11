// Polyglot matching engine — .NET port of apps/polyglot/engines/go/main.go.
//
// Npgsql for the LISTEN/queries side. SortedDictionary for the price-level
// ladder. Same price-time priority algorithm as the Go reference.

using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using Npgsql;

string engineName = Environment.GetEnvironmentVariable("ENGINE_NAME") ?? "dotnet";
string url = Environment.GetEnvironmentVariable("DATABASE_URL")
    ?? throw new InvalidOperationException("DATABASE_URL is required");

// Npgsql wants Host=...;Port=...;Database=...;Username=...;Password=... —
// not the postgres:// URL we receive via env. Translate once.
string ToNpgsql(string pgUrl)
{
    var u = new Uri(pgUrl);
    var userInfo = u.UserInfo.Split(':', 2);
    var user = Uri.UnescapeDataString(userInfo[0]);
    var pass = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : "";
    var db = u.AbsolutePath.TrimStart('/');
    var port = u.Port == -1 ? 5432 : u.Port;
    return $"Host={u.Host};Port={port};Database={db};Username={user};Password={pass};Pooling=true";
}
string dsn = ToNpgsql(url);

var engine = new Engine(engineName);

// Reconnect loop: pgstack restart kills the LISTEN connection, and
// Npgsql.WaitAsync would just throw forever without us reopening.
// Each session opens both clients, runs until any error, then the outer
// loop sleeps 2s and tries again.
while (true)
{
    try
    {
        await RunSession();
        Console.Error.WriteLine("session ended cleanly — reconnecting in 2s");
    }
    catch (Exception e)
    {
        Console.Error.WriteLine($"session error: {e.Message} — reconnecting in 2s");
    }
    await Task.Delay(TimeSpan.FromSeconds(2));
}

async Task RunSession()
{
    await using var drainConn = new NpgsqlConnection(dsn);
    await drainConn.OpenAsync();

    await using var listenConn = new NpgsqlConnection(dsn);
    await listenConn.OpenAsync();

    // Npgsql doesn't permit concurrent commands on the same connection;
    // two LISTEN notifications arriving back-to-back would otherwise race
    // inside DrainOnceAsync and the second call would error with "command
    // is already in progress". Serialise drains with a 1-permit semaphore.
    var drainLock = new SemaphoreSlim(1, 1);
    Exception? fatalError = null;

    async Task DrainSerialised(string label)
    {
        await drainLock.WaitAsync();
        try
        {
            await engine.DrainOnceAsync(drainConn);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"{label}: {e.Message}");
            // Conn-level errors should kill the session so the outer
            // loop reconnects. Logical errors (bad SQL) repeat each
            // notification but never escape, which is the same behavior
            // as the engine-side errors in other languages.
            if (drainConn.State != System.Data.ConnectionState.Open)
                fatalError = e;
        }
        finally
        {
            drainLock.Release();
        }
    }

    await DrainSerialised("initial drain");

    listenConn.Notification += async (_, _) => await DrainSerialised("drain");

    await using (var cmd = new NpgsqlCommand("LISTEN order_event_added", listenConn))
        await cmd.ExecuteNonQueryAsync();

    Console.Error.WriteLine($"engine {engineName} listening on order_event_added");

    while (fatalError == null)
    {
        try { await listenConn.WaitAsync(); }
        catch (Exception e) { fatalError = e; break; }
    }
    throw fatalError;
}


// ── Types ──

record OrderRow(long Id, string Symbol, string Side, string OrderType, decimal Price, decimal Qty, long? ParentOrder);

record Fill(long OrderId, decimal MatchedQty, decimal FillPrice, int LatencyUs, string TakerSide);

class RestingOrder { public long Id; public decimal Qty; }

class Book
{
    public string Side;
    public SortedDictionary<decimal, LinkedList<RestingOrder>> Levels;
    public Dictionary<long, (decimal Price, RestingOrder Ref)> ById = new();

    public Book(string side)
    {
        Side = side;
        Levels = side == "buy"
            ? new SortedDictionary<decimal, LinkedList<RestingOrder>>(Comparer<decimal>.Create((a, b) => b.CompareTo(a)))
            : new SortedDictionary<decimal, LinkedList<RestingOrder>>();
    }

    public decimal? Best() => Levels.Count == 0 ? null : Levels.Keys.First();

    public decimal TotalQtyAt(decimal p) =>
        Levels.TryGetValue(p, out var q) ? q.Sum(o => o.Qty) : 0m;

    public int OrderCountAt(decimal p) =>
        Levels.TryGetValue(p, out var q) ? q.Count : 0;

    public void Add(long id, decimal price, decimal qty)
    {
        if (!Levels.TryGetValue(price, out var q))
        {
            q = new LinkedList<RestingOrder>();
            Levels[price] = q;
        }
        var ro = new RestingOrder { Id = id, Qty = qty };
        q.AddLast(ro);
        ById[id] = (price, ro);
    }

    public void Cancel(long id)
    {
        if (!ById.Remove(id, out var ref0)) return;
        if (!Levels.TryGetValue(ref0.Price, out var q)) return;
        var node = q.Find(ref0.Ref);
        if (node != null) q.Remove(node);
        if (q.Count == 0) Levels.Remove(ref0.Price);
    }
}

class SymbolState
{
    public Book Bids = new("buy");
    public Book Asks = new("sell");

    public List<Fill> Match(OrderRow o, Stopwatch sw)
    {
        var fills = new List<Fill>();
        var opposite = o.Side == "buy" ? Asks : Bids;
        decimal remaining = o.Qty;

        while (remaining > 0)
        {
            var best = opposite.Best();
            if (best == null) break;
            if (o.OrderType == "limit")
            {
                if (o.Side == "buy"  && best.Value > o.Price) break;
                if (o.Side == "sell" && best.Value < o.Price) break;
            }
            var queue = opposite.Levels[best.Value];
            while (queue.Count > 0 && remaining > 0)
            {
                var head = queue.First!.Value;
                var matched = Math.Min(head.Qty, remaining);
                fills.Add(new Fill(o.Id, matched, best.Value,
                    Math.Max(1, (int)(sw.ElapsedTicks * 1_000_000L / Stopwatch.Frequency)),
                    o.Side));
                head.Qty -= matched;
                remaining -= matched;
                if (head.Qty <= 0)
                {
                    opposite.ById.Remove(head.Id);
                    queue.RemoveFirst();
                }
            }
            if (queue.Count == 0) opposite.Levels.Remove(best.Value);
        }

        if (o.OrderType == "limit" && remaining > 0)
        {
            var mine = o.Side == "buy" ? Bids : Asks;
            mine.Add(o.Id, o.Price, remaining);
        }
        return fills;
    }
}

class Engine
{
    private const int ReservoirMax = 1024;
    private readonly string _name;
    private long _lastSeenId;
    private readonly Dictionary<string, SymbolState> _state = new();
    private readonly Queue<int> _reservoir = new();

    public Engine(string name) { _name = name; }

    SymbolState GetState(string symbol)
    {
        if (!_state.TryGetValue(symbol, out var st))
        {
            st = new SymbolState();
            _state[symbol] = st;
        }
        return st;
    }

    (double avg, int p99) Stats()
    {
        if (_reservoir.Count == 0) return (0.0, 0);
        var arr = _reservoir.ToArray();
        var avg = arr.Average();
        Array.Sort(arr);
        var idx = Math.Min(arr.Length - 1, (int)(arr.Length * 0.99));
        return (avg, arr[idx]);
    }

    public async Task DrainOnceAsync(NpgsqlConnection conn)
    {
        var rows = new List<OrderRow>();
        // Track the highest id seen this batch, INCLUDING rows we skip below.
        // _lastSeenId must advance past a skipped row or the next poll re-reads
        // it forever (a poison row would pin the engine permanently).
        long maxIdInBatch = _lastSeenId;
        await using (var cmd = new NpgsqlCommand(
            @"SELECT id, symbol, side, order_type, COALESCE(price, 0), qty, parent_order
              FROM public.order_events WHERE id > @last ORDER BY id LIMIT 256", conn))
        {
            cmd.Parameters.AddWithValue("last", _lastSeenId);
            await using var rdr = await cmd.ExecuteReaderAsync();
            while (await rdr.ReadAsync())
            {
                long id = rdr.GetInt64(0);
                if (id > maxIdInBatch) maxIdInBatch = id;

                decimal price, qty;
                try
                {
                    // PostgreSQL numeric is wider than .NET decimal (max ~7.9e28).
                    // place_order caps price/qty at 1e9, but guard anyway so a row
                    // inserted out-of-band cannot crash the reader loop forever.
                    price = rdr.GetDecimal(4);
                    qty = rdr.GetDecimal(5);
                }
                catch (OverflowException)
                {
                    Console.Error.WriteLine(
                        $"[{_name}] skipping order {id}: price/qty out of decimal range");
                    continue;   // skip poison row; maxIdInBatch already advanced
                }

                rows.Add(new OrderRow(
                    id,
                    rdr.GetString(1),
                    rdr.GetString(2),
                    rdr.GetString(3),
                    price,
                    qty,
                    rdr.IsDBNull(6) ? (long?)null : rdr.GetInt64(6)));
            }
        }
        if (rows.Count == 0)
        {
            // Even with nothing to process, advance past any skipped poison rows.
            if (maxIdInBatch > _lastSeenId) _lastSeenId = maxIdInBatch;
            return;
        }

        var allFills = new List<Fill>();
        var touched = new Dictionary<string, HashSet<(string side, decimal price)>>();

        foreach (var o in rows)
        {
            var sw = Stopwatch.StartNew();
            var st = GetState(o.Symbol);
            if (o.OrderType == "cancel" && o.ParentOrder.HasValue)
            {
                st.Bids.Cancel(o.ParentOrder.Value);
                st.Asks.Cancel(o.ParentOrder.Value);
                continue;
            }
            var fills = st.Match(o, sw);
            allFills.AddRange(fills);
            if (!touched.TryGetValue(o.Symbol, out var tset))
            {
                tset = new HashSet<(string, decimal)>();
                touched[o.Symbol] = tset;
            }
            var oppSide = o.Side == "buy" ? "sell" : "buy";
            tset.Add((oppSide, o.Price));
            tset.Add((o.Side, o.Price));
            foreach (var f in fills) tset.Add((oppSide, f.FillPrice));
        }

        await using var tx = await conn.BeginTransactionAsync();
        foreach (var f in allFills)
        {
            await using var cmd = new NpgsqlCommand(
                @"INSERT INTO public.engine_fills
                    (engine, order_id, matched_qty, fill_price, latency_us, taker_side)
                  VALUES (@e, @oid, @mq, @fp, @lat, @ts)", conn, tx);
            cmd.Parameters.AddWithValue("e", _name);
            cmd.Parameters.AddWithValue("oid", f.OrderId);
            cmd.Parameters.AddWithValue("mq", f.MatchedQty);
            cmd.Parameters.AddWithValue("fp", f.FillPrice);
            cmd.Parameters.AddWithValue("lat", f.LatencyUs);
            cmd.Parameters.AddWithValue("ts", f.TakerSide);
            await cmd.ExecuteNonQueryAsync();
            _reservoir.Enqueue(f.LatencyUs);
            while (_reservoir.Count > ReservoirMax) _reservoir.Dequeue();
        }

        foreach (var (symbol, levels) in touched)
        {
            var st = GetState(symbol);
            foreach (var (side, price) in levels)
            {
                var book = side == "buy" ? st.Bids : st.Asks;
                var total = book.TotalQtyAt(price);
                var count = book.OrderCountAt(price);
                if (total == 0m)
                {
                    await using var cmd = new NpgsqlCommand(
                        "DELETE FROM public.engine_book WHERE engine=@e AND symbol=@s AND side=@side AND price=@p",
                        conn, tx);
                    cmd.Parameters.AddWithValue("e", _name);
                    cmd.Parameters.AddWithValue("s", symbol);
                    cmd.Parameters.AddWithValue("side", side);
                    cmd.Parameters.AddWithValue("p", price);
                    await cmd.ExecuteNonQueryAsync();
                }
                else
                {
                    await using var cmd = new NpgsqlCommand(
                        @"INSERT INTO public.engine_book (engine, symbol, side, price, total_qty, order_count, updated_at)
                          VALUES (@e, @s, @side, @p, @tq, @c, now())
                          ON CONFLICT (engine, symbol, side, price) DO UPDATE
                            SET total_qty = EXCLUDED.total_qty,
                                order_count = EXCLUDED.order_count,
                                updated_at = now()", conn, tx);
                    cmd.Parameters.AddWithValue("e", _name);
                    cmd.Parameters.AddWithValue("s", symbol);
                    cmd.Parameters.AddWithValue("side", side);
                    cmd.Parameters.AddWithValue("p", price);
                    cmd.Parameters.AddWithValue("tq", total);
                    cmd.Parameters.AddWithValue("c", count);
                    await cmd.ExecuteNonQueryAsync();
                }
            }
        }

        var (avg, p99) = Stats();
        var totalVolume = allFills.Sum(f => f.MatchedQty);
        await using (var cmd = new NpgsqlCommand(
            @"UPDATE public.engine_stats
                SET total_orders   = total_orders   + @no,
                    total_matches  = total_matches  + @nm,
                    total_volume   = total_volume   + @tv,
                    avg_latency_us = @avg,
                    p99_latency_us = @p99,
                    last_updated   = now()
              WHERE engine = @e", conn, tx))
        {
            cmd.Parameters.AddWithValue("e", _name);
            cmd.Parameters.AddWithValue("no", (long)rows.Count);
            cmd.Parameters.AddWithValue("nm", (long)allFills.Count);
            cmd.Parameters.AddWithValue("tv", totalVolume);
            cmd.Parameters.AddWithValue("avg", avg);
            cmd.Parameters.AddWithValue("p99", p99);
            await cmd.ExecuteNonQueryAsync();
        }

        await tx.CommitAsync();
        // Advance past every row read this batch, including skipped poison rows
        // (maxIdInBatch >= rows[^1].Id).
        _lastSeenId = maxIdInBatch;
    }
}
