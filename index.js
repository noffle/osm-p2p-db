var hyperkv = require('hyperkv')
var hyperkdb = require('hyperlog-kdb-index')
var kdbtree = require('kdb-tree-store')
var hindex = require('hyperlog-index')
var sub = require('subleveldown')
var randomBytes = require('randombytes')
var has = require('has')
var once = require('once')
var through2 = require('through2')
var readonly = require('read-only-stream')

module.exports = DB

function DB (opts) {
  var self = this
  if (!(self instanceof DB)) return new DB(opts)
  self.log = opts.log
  self.db = opts.db
  self.kv = hyperkv({
    log: self.log,
    db: sub(self.db, 'kv')
  })
  self.kdb = hyperkdb({
    log: self.log,
    store: opts.store,
    db: sub(self.db, 'kdb'),
    size: opts.size || opts.store.size,
    kdbtree: kdbtree,
    types: [ 'float', 'float' ],
    map: function (row) {
      if (row.value && row.value.v && Array.isArray(row.value.v.loc)) {
        return row.value.v.loc
      }
    }
  })
  self.refdb = sub(self.db, 'rx', { valueEncoding: 'json' })
  self.refdex = hindex(self.log, sub(self.db, 'ri'), function (row, next) {
    next = once(next)
    if (!row.value || !row.value.v) return next()
    var k = row.value.k, v = row.value.v
    var refs = (v.refs || []).concat(v.members || [])
    var batch = [], pending = 1

    refs.forEach(function (ref) {
      pending++
      self.refdb.get(ref, function (err, links) {
        //if (err) return next(err)
        if (!links) links = []
        var ln = {}
        links.forEach(function (link) { ln[link] = true })
        row.links.forEach(function (link) { delete ln[link] })
        ln[row.key] = true
        batch.push({ type: 'put', key: ref, value: Object.keys(ln) })
        if (--pending === 0) insert()
      })
    })
    if (--pending === 0) insert()

    function insert () {
      self.refdb.batch(batch, next)
    }
  })
}

DB.prototype._links = function (ref, cb) {
  this.refdb.get(ref, cb)
}

DB.prototype.ready = function (cb) {
  var self = this
  var pending = 2
  self.refdex.ready(ready)
  self.kdb.ready(ready)
  function ready () { if (--pending === 0) cb() }
}

DB.prototype.create = function (value, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!opts) opts = {}
  if (!cb) cb = noop
  var key = randomBytes(8).toString('hex')
  return this.put(key, value, opts, function (err, node) {
    cb(err, key, node)
  })
}

DB.prototype.put = function (key, value, opts, cb) {
  this.kv.put(key, value, opts, cb)
}

DB.prototype.get = function (key, opts, cb) {
  this.kv.get(key, opts, cb)
}

DB.prototype.query = function (q, opts, cb) {
  var self = this
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!opts) opts = {}
  cb = once(cb || noop)
  self.ready(function () {
    self.kdb.query(q, opts, onquery)
  })
  function onquery (err, pts) {
    if (err) return cb(err)
    var pending = 1
    pts.forEach(function (pt) {
      pending++
      self._links(pt.value, function (err, links) {
        if (!links) links = []
        links.forEach(function (link) {
          pending++
          self.log.get(link, function (err, doc) {
            if (err) return cb(err)
            pts.push(doc)
            if (--pending === 0) cb(null, pts)
          })
        })
        if (--pending === 0) cb(null, pts)
      })
    })
    if (--pending === 0) cb(null, pts)
  }
}

DB.prototype.queryStream = function (q, opts) {
  var self = this
  self.ready(function () {
    var r = self.kdb.queryStream(q, opts)
    r.on('error', stream.emit.bind(stream, 'error'))
    r.pipe(stream)
  })
  var stream = through.obj(write)
  return readonly(stream)

  function write (row, enc, next) {
    next = once(next)
    var tr = this
    tr.push(row)
    self._links(row.value, function (err, links) {
      var pending = 1
      links.forEach(function (link) {
        pending++
        self.log.get(link, function (err, doc) {
          if (err) return next(err)
          tr.push({ key: link, value: doc })
          if (--pending === 0) next()
        })
      })
      if (--pending === 0) next()
    })
  }
}

function noop () {}