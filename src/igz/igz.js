import { readFileSync, writeFileSync } from 'fs'
import { BufferView } from '../utils.js'
import Fixup from './fixup.js'
import igObject from './igObject.js'
import ChunkInfo from './chunkInfos.js'
import NSTPC from '../../assets/crash/NSTPC.txt'

class IGZ {
    constructor(igz_data, path) {
        this.path = path
        this.updated = false
        this.header = null
        this.chunk_infos = []
        this.fixups = {}
        this.objects = []

        this.objectList = null // objects[0]
        this.nameList = null   // objects[-1]

        this.initialize(new Uint8Array(igz_data))
    }

    /** Construct from .igz file path
     * @param {string} filePath path to the file
    */
    static fromFile(filePath) {
        const data = readFileSync(filePath)
        return new IGZ(data, filePath)
    }

    initialize(buffer) {
        const reader = new BufferView(buffer)

        /// Header ///

        const signature = reader.readInt()
        const version   = reader.readInt()

        if (signature != 0x49475a01) throw new Error('Invalid signature: ' + signature)
        if (version != 10) throw new Error('Invalid version: ' + version)

        this.header = reader.readBytes(2048, 0)

        /// Chunk infos ///

        reader.seek(16)

        while(true) {
            const info = ChunkInfo.fromBuffer(reader)
            if (info == null) break

            this.chunk_infos.push(info)
        }

        /// Fixups (Chunk 0) ///

        reader.seek(this.chunk_infos[0].offset)

        while (true) {
            const fixup = Fixup.fromBuffer(reader)
            if (fixup == null) break

            this.fixups[fixup.type] = fixup
        }
        
        if (this.fixups.TMET == null) throw new Error('TMET fixup not found')
        if (this.fixups.RVTB == null) throw new Error('RVTB fixup not found')
        if (this.fixups.TSTR == null) console.warn('TSTR fixup not found')
        if (this.fixups.ROFS == null) console.warn('ROFS fixup not found')
        if (this.fixups.ONAM == null) console.warn('ONAM fixup not found')
        if (this.fixups.TSTR == null || this.fixups.ROFS == null || this.fixups.ONAM == null) {
            return
        }
    
        if (this.fixups.EXNM) {
            // Init EXNM fixup data
            this.fixups.EXNM.data = this.fixups.EXNM.data.map(([a, b]) => ([this.fixups.TSTR.data[a], this.fixups.TSTR.data[b]]))
        }

        /// Objects (Chunk 1) ///

        const rvtb = this.fixups.RVTB.data
        const sorted_offsets = rvtb.concat(this.chunk_infos[1].size).sort((a, b) => a - b)

        for (const [index, offset] of Object.entries(rvtb)) {
            const sortedID = sorted_offsets.indexOf(offset)
            const nextOffset = sorted_offsets[sortedID + 1]
            const size = nextOffset - offset

            const dataOffset = this.chunk_infos[1].offset + offset

            if (dataOffset > reader.buffer.length) continue // Special case for Vertex igz files (not handled)

            const data = reader.readBytes(size, dataOffset)

            const typeID = reader.readInt(dataOffset)
            const type = this.fixups.TMET.data[typeID]

            if (type == null) throw new Error('Type is null: ' + typeID)

            this.objects.push(new igObject({ index, offset, size, type, typeID, data }))
        }

        this.objectList = this.objects[0]
        this.nameList = this.objects[this.objects.length - 1]

        /// Read root objects names ///

        const root_offsets = this.objectList.getList()
        const root_names   = this.nameList.getList()

        root_offsets.forEach((offset, i) => {
            const nameID = root_names[i]
            const name   = this.fixups.TSTR.data[nameID]
            const object = this.objects.find(e => e.offset == offset)

            if (name == null) throw new Error('Name is null: ' + nameID)
            if (object == null) console.warn(`Entry #${i} (offset: ${offset}, name: ${name}) is not present in RVTB`)

            object.name = name
            object.nameID = nameID
        })

        /// Add count to unnamed objects ///

        const types_count = {}
        this.objects.forEach(object => {
            if (object.nameID != -1) return
            const count = types_count[object.type] ?? 1
            types_count[object.type] = count + 1
            object.typeCount = count
        })


        /// Get children + references ///

        this.updateChildrenAndReferences = () => {
            for (const object of this.objects) {
                object.children = []
                object.references = []
            }

            for (const object of this.objects) {
                if (object.type == 'igStreamingChunkInfo') continue
                for (let k = 0; k < object.size; k += 4) {
                    const value = object.view.readInt(k)
                    if (value == 0) continue

                    const child = this.objects.find(e => e.offset == value)

                    if (child != null) {
                        // if (object.offset > 0) // Do not add igObjectList reference
                            child.references.push(object)

                        object.children.push({ object: child, offset: k })
                    }
                }
            }
        }
        this.updateChildrenAndReferences()
    }

    save(filePath) {
        // Update start offsets
        const sorted_objects = this.objects.sort((a, b) => a.offset - b.offset)
        for (let i = 1; i < sorted_objects.length; i++) {
            const object = sorted_objects[i]
            const prevEndOffset = sorted_objects[i - 1].offset + sorted_objects[i - 1].size

            if (object.offset != prevEndOffset) {
                console.log('Updated START offset for ' + object.getName() + ' from ' + object.offset + ' to ' + prevEndOffset + ' (' + (object.offset - prevEndOffset) + ')')
                object.offset = prevEndOffset
            }
        }

        // Update igObjectList + igNameList
        const namedObjects = this.objectList.getList().map(off => this.objects.find(e => e.offset == off)).filter(e => e != null)
        this.objectList.updateList(namedObjects.map(e => e.offset))
        this.nameList.updateList(namedObjects.map(e => this.fixups.TSTR.data.indexOf(e.name)))

        // Update fixups
        if (this.path.includes('_pkg')) {
            this.fixups.RVTB.updateData(this.buildRVTB())
            this.fixups.ONAM.updateData(this.buildONAM())
            this.fixups.ROFS.updateData(this.buildROFS())
            this.fixups.RSTT.updateData(this.buildRSTT())
        }

        // Update chunk infos
        this.chunk_infos[0].size = Object.values(this.fixups).reduce((a, b) => a + b.size, 0)
        this.chunk_infos[1].offset = this.chunk_infos[0].offset + this.chunk_infos[0].size
        this.chunk_infos[1].size = this.objects.reduce((a, b) => a + b.size, 0)

        const fileSize = this.chunk_infos[0].offset + this.chunk_infos.reduce((a, b) => a + b.size, 0)

        // Write full header
        const buffer = new Uint8Array(this.header.concat(new Array(fileSize - this.header.length).fill(0)))
        const writer = new BufferView(buffer)

        // Re-write chunk infos
        writer.seek(16) // Skip header
        this.chunk_infos.forEach(e => e.save(writer))

        // Write fixups
        writer.seek(this.chunk_infos[0].offset)
        Object.values(this.fixups).forEach(e => e.save(writer))

        // Write objects
        const objects_start = this.chunk_infos[1].offset
        writer.seek(objects_start)
        this.objects.forEach(e => {
            if (writer.offset - objects_start != e.offset) throw new Error('Offset mismatch: ' + (writer.offset - objects_start) + ' != ' + e.offset)
            e.save(writer, objects_start)
        })

        this.updated = false
        this.objects.forEach(e => e.updated = false)

        if (filePath) {
            writeFileSync(filePath, writer.view)
        }

        return writer.buffer
    }

    /**
     * Find all external files that are referenced in TDEP
     * @param {Pak} pak Parent PAK object
     * @returns {string[]} A list of unique file paths
     */
    getDependencies(pak) {
        const findTDEPDependency = (e) => pak.files.find(f => f.path.endsWith(e))?.path

        // Get dependencies
        const tdep = this.fixups.TDEP?.data ?? []
        const tdep_files = tdep.map(([name, path]) => findTDEPDependency(path.split('/').pop())).filter(e => e != null)

        // Remove duplicates
        const all_files = new Set(tdep_files)

        return Array.from(all_files)
    }

    /**
     * Update the TSTR and chunk_info objects of this package file
     * Only call this function on *_pkg.igz files
     * @param {string[]} file_paths List containing all paths of the oarent .pak archive
     * @returns New igz file buffer
     */
    updatePKG(file_paths) {
        const nst_data = JSON.parse(NSTPC)

        const typesOrder = [
            'script', 'sound_sample', 'sound_bank', 'lang_file',
            'texture', 'material_instances', 'vsc', 'igx_file', 
            'havokrigidbody', 'model', 'asset_behavior', 
            'havokanimdb', 'hkb_behavior', 'hkc_character', 
            'behavior', 'sky_model', 'effect', 'actorskin', 
            'sound_stream', 'character_events', 'graphdata_behavior', 
            'navmesh', 'igx_entities', 'pkg'
        ]

        const filesByType = Object.fromEntries(typesOrder.map(e => [e, []]))
        const types = new Set()

        // Group files by type
        for (let i = 0; i < file_paths.length; i++) {
            const path = file_paths[i]
            const type = nst_data[path].type

            if (filesByType[type] == null) throw new Error('Type not found: ' + type)
            else filesByType[type].push(path)

            types.add(type)
        }

        // Build new TSTR data
        const files = typesOrder.map(e => filesByType[e]).flat()
        const new_TSTR  = Array.from(types).sort((a, b) => a.localeCompare(b))
                         .concat(files)
                         .concat('chunk_info')

        // Update TSTR
        this.fixups.TSTR.updateData(new_TSTR)

        // Build new chunk_info data
        const chunk_info_data = []
        for (let i = 0; i < files.length; i++) {
            const file_path = files[i]
            const file_type = nst_data[file_path].type

            const file_path_id = new_TSTR.indexOf(file_path)
            const file_type_id = new_TSTR.indexOf(file_type)

            chunk_info_data.push([file_type_id, file_path_id])
        }

        // Update chunk_info
        const chunk_info = this.objects[1]
        chunk_info.updatePKG(chunk_info_data)

        return this.save()
    }

    buildONAM() {
        return [ this.objects.find(e => e.type == 'igNameList').offset ]
    }

    buildRVTB() {
        return this.objects.map(e => e.offset)
    }

    buildROFS() {
        const mandatory_offsets = {
            'igObjectList': [0x20],
            'igNameList': [0x20],
            'igStreamingChunkInfo': [0x38],
        }
        const rofs = []

        for (const entry of this.objects.filter(e => !e.deleted)) {
            const offsets = entry.children
                            .filter(e => entry.type == 'igObjectList')
                            .map(e => e.offset)

                            .concat(mandatory_offsets[entry.type] ?? [])
                            .map(e => e + entry.offset)
                            .sort((a, b) => a - b)

            rofs.push(...offsets)
        }

        return rofs
    }

    buildRSTT() {
        const rstt = []

        const chunk_info = this.objects.find(e => e.type == 'igStreamingChunkInfo')
        if (chunk_info) {
            const file_count = this.fixups.TSTR.data.filter(e => e.includes('.')).length
            for (let i = 0; i < file_count * 2; i++) {
                rstt.push(i * 8 + 112)
            }
        }

        for (let i = 0; i < this.nameList.getList().length; i++) {
            rstt.push(this.nameList.offset + 40 + i * this.nameList.element_size)
        }

        return rstt
    }

    getRootObjects() {
        return this.objects.filter(e => e.references.length == 1 && e.references[0].type == 'igObjectList')
    }

    toNodeTree() {
        return [{
            text: 'Fixups',
            children: Object.values(this.fixups).map(e => e.toNodeTree(this.objects)),
        }, {
            text: 'Unreferenced objects',
            children: this.objects.filter(e => e.references.length == 0).map(e => e.toNodeTree())
        }, {
            text: 'Root Objects',
            children: this.getRootObjects().map(e => e.toNodeTree()),
        }]
    }

    toString() {
        return {
            file_size: this.chunk_infos.reduce((a, b) => a + b.size, 0) + this.chunk_infos[0].offset,
            total_objects: this.objects.length,
            named_objects: this.objectList?.getList().length,
            root_objects: this.getRootObjects().length,
            chunk_infos: this.chunk_infos.map(e => e.toString()),
            fixups: Object.fromEntries(Object.values(this.fixups).map(e => [e.type, e.item_count]))
        }
    }
}

export default IGZ