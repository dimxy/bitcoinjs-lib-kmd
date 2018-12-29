import { Payment, PaymentOpts } from './index'
import { Network } from '../networks'
import * as bscript from '../script'
import * as bcrypto from '../crypto'
import * as lazy from './lazy'
import { bitcoin as BITCOIN_NETWORK } from '../networks'
const typef = require('typeforce')
const OPS = require('bitcoin-ops')

const bs58check = require('bs58check')

function stacksEqual (a: Array<Buffer>, b: Array<Buffer>): boolean {
  if (a.length !== b.length) return false

  return a.every(function (x, i) {
    return x.equals(b[i])
  })
}

// input: [redeemScriptSig ...] {redeemScript}
// witness: <?>
// output: OP_HASH160 {hash160(redeemScript)} OP_EQUAL
export function p2sh (a: Payment, opts?: PaymentOpts): Payment {
  if (
    !a.address &&
    !a.hash &&
    !a.output &&
    !a.redeem &&
    !a.input
  ) throw new TypeError('Not enough data')
  opts = Object.assign({ validate: true }, opts || {})

  typef({
    network: typef.maybe(typef.Object),

    address: typef.maybe(typef.String),
    hash: typef.maybe(typef.BufferN(20)),
    output: typef.maybe(typef.BufferN(23)),

    redeem: typef.maybe({
      network: typef.maybe(typef.Object),
      output: typef.maybe(typef.Buffer),
      input: typef.maybe(typef.Buffer),
      witness: typef.maybe(typef.arrayOf(typef.Buffer))
    }),
    input: typef.maybe(typef.Buffer),
    witness: typef.maybe(typef.arrayOf(typef.Buffer))
  }, a)

  let network = a.network
  if (!network) {
    network = (a.redeem && a.redeem.network) || BITCOIN_NETWORK
  }

  const o: Payment = { network }

  const _address = lazy.value(function () {
    const payload = bs58check.decode(a.address)
    const version = payload.readUInt8(0)
    const hash = payload.slice(1)
    return { version, hash }
  })
  const _chunks = <()=>Array<Buffer | number>>lazy.value(function () { return bscript.decompile(<Buffer>a.input) })
  const _redeem = lazy.value(function (): Payment {
    const chunks = _chunks()
    return {
      network,
      output: <Buffer>chunks[chunks.length - 1],
      input: bscript.compile(chunks.slice(0, -1)),
      witness: a.witness || []
    }
  })

  // output dependents
  lazy.prop(o, 'address', function () {
    if (!o.hash) return

    const payload = Buffer.allocUnsafe(21)
    payload.writeUInt8((<Network>o.network).scriptHash, 0)
    o.hash.copy(payload, 1)
    return bs58check.encode(payload)
  })
  lazy.prop(o, 'hash', function () {
    // in order of least effort
    if (a.output) return a.output.slice(2, 22)
    if (a.address) return _address().hash
    if (o.redeem && o.redeem.output) return bcrypto.hash160(o.redeem.output)
  })
  lazy.prop(o, 'output', function () {
    if (!o.hash) return
    return bscript.compile([
      OPS.OP_HASH160,
      o.hash,
      OPS.OP_EQUAL
    ])
  })

  // input dependents
  lazy.prop(o, 'redeem', function () {
    if (!a.input) return
    return _redeem()
  })
  lazy.prop(o, 'input', function () {
    if (!a.redeem || !a.redeem.input || !a.redeem.output) return
    return bscript.compile((<Array<Buffer | number>>[]).concat(
      <Array<Buffer | number>>bscript.decompile(a.redeem.input),
      a.redeem.output
    ))
  })
  lazy.prop(o, 'witness', function () {
    if (o.redeem && o.redeem.witness) return o.redeem.witness
    if (o.input) return []
  })

  if (opts.validate) {
    let hash: Buffer = Buffer.from([])
    if (a.address) {
      if (_address().version !== network.scriptHash) throw new TypeError('Invalid version or Network mismatch')
      if (_address().hash.length !== 20) throw new TypeError('Invalid address')
      hash = _address().hash
    }

    if (a.hash) {
      if (hash.length > 0 && !hash.equals(a.hash)) throw new TypeError('Hash mismatch')
      else hash = a.hash
    }

    if (a.output) {
      if (
        a.output.length !== 23 ||
        a.output[0] !== OPS.OP_HASH160 ||
        a.output[1] !== 0x14 ||
        a.output[22] !== OPS.OP_EQUAL) throw new TypeError('Output is invalid')

      const hash2 = a.output.slice(2, 22)
      if (hash.length > 0 && !hash.equals(hash2)) throw new TypeError('Hash mismatch')
      else hash = hash2
    }

    // inlined to prevent 'no-inner-declarations' failing
    const checkRedeem = function (redeem: Payment): void {
      // is the redeem output empty/invalid?
      if (redeem.output) {
        const decompile = bscript.decompile(redeem.output)
        if (!decompile || decompile.length < 1) throw new TypeError('Redeem.output too short')

        // match hash against other sources
        const hash2 = bcrypto.hash160(redeem.output)
        if (hash.length > 0 && !hash.equals(hash2)) throw new TypeError('Hash mismatch')
        else hash = hash2
      }

      if (redeem.input) {
        const hasInput = redeem.input.length > 0
        const hasWitness = redeem.witness && redeem.witness.length > 0
        if (!hasInput && !hasWitness) throw new TypeError('Empty input')
        if (hasInput && hasWitness) throw new TypeError('Input and witness provided')
        if (hasInput) {
          const richunks = <Array<Buffer | number>>bscript.decompile(redeem.input)
          if (!bscript.isPushOnly(richunks)) throw new TypeError('Non push-only scriptSig')
        }
      }
    }

    if (a.input) {
      const chunks = _chunks()
      if (!chunks || chunks.length < 1) throw new TypeError('Input too short')
      if (!Buffer.isBuffer(_redeem().output)) throw new TypeError('Input is invalid')

      checkRedeem(_redeem())
    }

    if (a.redeem) {
      if (a.redeem.network && a.redeem.network !== network) throw new TypeError('Network mismatch')
      if (a.input) {
        const redeem = _redeem()
        if (a.redeem.output && !a.redeem.output.equals(<Buffer>redeem.output)) throw new TypeError('Redeem.output mismatch')
        if (a.redeem.input && !a.redeem.input.equals(<Buffer>redeem.input)) throw new TypeError('Redeem.input mismatch')
      }

      checkRedeem(a.redeem)
    }

    if (a.witness) {
      if (
        a.redeem &&
        a.redeem.witness &&
        !stacksEqual(a.redeem.witness, a.witness)) throw new TypeError('Witness and redeem.witness mismatch')
    }
  }

  return Object.assign(o, a)
}