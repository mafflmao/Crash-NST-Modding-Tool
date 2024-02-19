class BufferView {
    constructor(buffer, littleEndian = true) {
        this.buffer = buffer
        this.view = new DataView(buffer.buffer)
        this.littleEndian = littleEndian
        this.offset = 0
    }

    seek(offset) {
        this.offset = offset
    }

    getValue(method, size, offset) {
        this.offset = offset ?? this.offset

        if (this.offset + size > this.view.byteLength) {
            console.log(method, this.offset, size, this.view.byteLength)
            throw new Error('Reading past end of buffer')
        }

        const value = this.view[method](this.offset, this.littleEndian)
        this.offset += size

        return value
    }

    setValue(method, size, value, offset) {
        this.offset = offset ?? this.offset

        if (this.offset + size > this.view.byteLength) {
            console.log(method, this.offset, size, this.view.byteLength)
            throw new Error('Writing past end of buffer')
        }

        this.view[method](this.offset, value, this.littleEndian)
        this.offset += size
    }

    readLong   = (offset) => this.getValue('getBigInt64', 8, offset)
    readULong  = (offset) => this.getValue('getBigUint64', 8, offset)
    readInt    = (offset) => this.getValue('getInt32', 4, offset)
    readUInt   = (offset) => this.getValue('getUint32', 4, offset)
    readFloat  = (offset) => this.getValue('getFloat32', 4, offset)
    readInt16  = (offset) => this.getValue('getInt16', 2, offset)
    readUInt16 = (offset) => this.getValue('getUint16', 2, offset)
    readVector    = (offset, size) => new Array(size).fill(0).map((_, i) => this.readFloat(i == 0 ? offset : null))
    readVectorInt = (offset, size) => new Array(size).fill(0).map((_, i) => this.readInt(i == 0 ? offset : null))
    readByte   = (offset) => this.getValue('getUint8', 1, offset)
    readInt8   = (offset) => this.getValue('getInt8', 1, offset)
    readUInt8  = this.readByte
    readBytes  = (size, offset) => new Array(size).fill(0).map((_, i) => this.readByte(i == 0 ? offset : null))
    readChars  = (size, offset) => String.fromCharCode(...this.readBytes(size, offset))
    readStr    = (offset) => {
        this.offset = offset ?? this.offset
        let str = ''
        while (true) {
            const char = this.readByte()
            if (char == 0) return str
            str += String.fromCharCode(char)
        }
    }

    setLong  = (value, offset) => this.setValue('setBigInt64', 8, BigInt(value), offset)
    setULong = (value, offset) => this.setValue('setBigUint64', 8, BigInt(value), offset)
    setInt   = (value, offset) => this.setValue('setInt32', 4, value, offset)
    setUInt  = (value, offset) => this.setValue('setUint32', 4, value, offset)
    setInt16 = (value, offset) => this.setValue('setInt16', 2, value, offset)
    setFloat = (value, offset) => this.setValue('setFloat32', 4, value, offset)
    setVector = (values, offset) => values.forEach((value, i) => this.setFloat(value, i == 0 ? offset : null))
    setChars = (value, offset) => this.setBytes([...value].map(e => e.charCodeAt(0)), offset)
    setByte  = (value, offset) => this.setValue('setUint8', 1, value, offset)
    setBytes = (values, offset) => {
        this.offset = offset ?? this.offset
        this.buffer.set(values, this.offset)
        this.offset += values.length
    }
}

function bytesToUInt(bytes, start = 0) {
    if (bytes.length < start + 4) throw new Error('Reading past end of buffer')
    const int = bytes[start] | (bytes[start + 1] << 8) | (bytes[start + 2] << 16) | (bytes[start + 3] << 24)
    return int >>> 0
}

function bytesToUInt16(bytes, start = 0) {
    if (bytes.length < start + 2) throw new Error('Reading past end of buffer')
    const int = bytes[start] | (bytes[start + 1] << 8)
    return int >>> 0
}

function intToBytes(int, byteCount = 4) {
    const bytes = []
    for (let i = 0; i < byteCount; i++) {
        bytes.push(int & 0xFF)
        int >>= 8
    }
    return bytes
}

function bitReplace(a, b, count, shift) {
    let m = (1 << count) - 1
    a = a & ~(m << shift)
    a = a | ((b & m) << shift)
    return a
}

function bitRead(a, count, shift) {
    return (a >> shift) & ((1 << count) - 1)
}

function formatSize(number) {
    return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") + ' bytes'
}

/**
 * Computes the hash for a file path, file name or object name
 * https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
 */
function computeHash(name) {
    name = name.toLowerCase()
    let b = 0x811c9dc5

    for (let i = 0; i < name.length; i++) {
        b ^= name.charCodeAt(i)
        b += (b << 1) + (b << 4) + (b << 7) + (b << 8) + (b << 24)
    }

    return b >>> 0
}

/**
 * Extracts a file name from its path, without the extension
 */
function extractName(str) {
    str = str.slice(str.lastIndexOf('/') + 1)
    str = str.slice(0, str.lastIndexOf('.'))
    return str
}

export {
    BufferView,
    bytesToUInt,
    bytesToUInt16,
    intToBytes,
    bitReplace,
    bitRead,
    formatSize,
    computeHash,
    extractName
}