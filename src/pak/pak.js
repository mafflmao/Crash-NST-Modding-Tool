import { writeFileSync, readFileSync } from 'fs'
import { BufferView, computeHash, extractName, formatSize } from "../utils"
import FileInfos from './fileInfos'
import IGZ from '../igz/igz'
import { file_types } from '../app/components/utils/metadata'

const PAK_VERSION   = 11
const PAK_SIGNATURE = 0x1A414749
const CUSTOM_SIGNATURE = 0xAABBCCDD
const HEADER_SIZE   = 56
const SECTOR_SIZE   = 2048

const FILE_COUNT_LOC   = 12
const SECTOR_SIZE_LOC  = 16
const BLOCK_TABLES_LOC = 28
const NAMES_OFFSET_LOC = 40
const NAMES_SIZE_LOC   = 48

class Pak {    
    constructor({ files = [], path } = {}) {
        this.files = files.map(e => new FileInfos({ ...e, pak: this }))
        this.path = path
        this.updated = false
        this.package_igz = null // Reference to the package file (ArchiveName_pkg.igz) as IGZ object

        this.block_tables = {
            large:  [],
            medium: [],
            small:  []
        }
    }

    /** Construct from .pak file path
     * @param {string} filePath path to the file
    */
    static fromFile(filePath) {
        const data = readFileSync(filePath)
        const pak = new Pak({ path: filePath })
        
        pak.initialize(data)
        
        return pak
    }

    initialize(buffer) {
        const reader = new BufferView(buffer)

        /// Read Header ///

        const file_count        = reader.readUInt(FILE_COUNT_LOC)
        const names_offset      = reader.readUInt(NAMES_OFFSET_LOC)
        const sector_size       = reader.readUInt(SECTOR_SIZE_LOC)
        const num_large_blocks  = reader.readUInt(BLOCK_TABLES_LOC)
        const num_medium_blocks = reader.readUInt()
        const num_small_blocks  = reader.readUInt()

        this.sector_size = sector_size

        /// Read Files ///

        reader.seek(HEADER_SIZE)
        
        for (let i = 0; i < file_count; i++) {
            // Read file ID
            const id = reader.readUInt(HEADER_SIZE + i * 4)

            // Read file infos
            reader.seek(HEADER_SIZE + file_count * 4 + i * 16)
            const offset      = reader.readUInt()
            const ordinal     = reader.readInt()
            const size        = reader.readUInt()
            const compression = reader.readUInt()

            // Read file data
            const data = buffer.slice(offset, offset + size)

            // Read file paths
            const file_name_offset = reader.readUInt(names_offset + i * 4)
            const full_path = reader.readStr(names_offset + file_name_offset)
            const path = reader.readStr()

            const file = new FileInfos({ pak: this, id, offset, ordinal, size, compression, full_path, path, data })

            this.files.push(file)
        }

        /// Read custom data ///

        if (reader.offset + 8 < buffer.byteLength) {
            const signature = reader.readUInt(reader.offset + 4)
            if (signature == CUSTOM_SIGNATURE) {
                this.custom_file = true
                this.files.forEach(e => e.original = reader.readByte() == 1)
                console.log('Custom file detected !')
            }
        }

        /// Read Block Tables ///

        reader.seek(HEADER_SIZE + file_count * 20)
        for (let i = 0; i < num_large_blocks; i++)  this.block_tables.large.push(reader.readUInt())
        for (let i = 0; i < num_medium_blocks; i++) this.block_tables.medium.push(reader.readUInt16())
        for (let i = 0; i < num_small_blocks; i++)  this.block_tables.small.push(reader.readUInt8())

        // Read package file ///
        
        const package_file = this.files.find(e => e.path.endsWith('_pkg.igz'))

        if (package_file != null) {
            this.package_igz = IGZ.fromFileInfos(package_file)

            // Check which files are included in the package file
            for (const file of this.files) {
                file.include_in_pkg = this.package_igz.fixups.TSTR?.data.includes(file.path.toLowerCase())
            }
        }
    }

    save(filePath, progressCallback) {
        const file_count = this.files.length
        const INFOS_START = HEADER_SIZE + file_count * 4
        const DATA_START  = HEADER_SIZE + file_count * 20

        // Update package file
        if (this.package_igz != null)
            this.updatePackageFile()

        // Calculate file IDs
        this.files.forEach(e => e.computeHash())

        // Sort files by ID (important!)
        this.files = this.files.sort((a, b) => a.id - b.id)

        // Calculate hash search divider & slop
        const { hashSearchDivider, hashSearchSlop } = this.calculateSearchDividerAndSlope()
        
        // Approximate file size upper bound
        const size = DATA_START 
            + this.files.reduce((acc, e) => acc + e.size, 0) 
            + 2048 * file_count
            + file_count * 4
            + this.files.reduce((acc, e) => acc + e.full_path.length + e.path.length + 6, 0)
        
        const buffer = new Uint8Array(size)
        const writer = new BufferView(buffer)
        const alignOffset = () => writer.offset += -writer.offset & 0x7FF

        // Write header
        writer.setInt(PAK_SIGNATURE)
        writer.setInt(PAK_VERSION)
        writer.setInt(file_count * 20)
        writer.setInt(file_count)
        writer.setInt(SECTOR_SIZE)
        writer.setInt(hashSearchDivider)
        writer.setInt(hashSearchSlop)
        writer.setBytes(new Uint8Array(24))
        writer.setInt(1)

        // Write file IDs
        this.files.forEach(e => writer.setUInt(e.id))

        // Goto start of data
        writer.seek(DATA_START)
        alignOffset()

        // Write each file data
        for (let i = 0; i < file_count; i++) {
            const file = this.files[i]
            const ordinal = (i - 1) << 0x8
            const file_data = file.getUncompressedData()

            file.offset  = writer.offset
            file.ordinal = ordinal

            writer.setBytes(file_data)
            alignOffset()

            if (progressCallback && (i%10 == 0 || i == file_count-1)) progressCallback(i, file_count)
        }

        alignOffset()

        const NAMES_START = writer.offset

        // Goto start of name strings (skip name offsets)
        writer.seek(NAMES_START + file_count * 4)

        for (let i = 0; i < file_count; i++) {
            const file = this.files[i]

            // Write name offset
            const name_offset = writer.offset - NAMES_START
            writer.setInt(name_offset, NAMES_START + i * 4)

            // Write name strings
            writer.seek(NAMES_START + name_offset)
            writer.setChars(file.full_path)
            writer.setByte(0)
            writer.setChars(file.path)
            writer.setBytes(new Uint8Array(5))
        }

        // Write custom data
        writer.setInt(CUSTOM_SIGNATURE)
        this.files.forEach(e => writer.setByte(e.original ? 1 : 0))

        const file_size = writer.offset
        const names_size = file_size - NAMES_START

        // Update header
        writer.setInt(NAMES_START, NAMES_OFFSET_LOC)
        writer.setInt(names_size, NAMES_SIZE_LOC)

        // Goto start of file infos
        writer.seek(INFOS_START)

        // Write file infos
        for (const file of this.files) {
            writer.setInt(file.offset)
            writer.setInt(file.ordinal)
            writer.setInt(file.size)
            writer.setInt(0xFFFFFFFF) // No compression
        }

        this.updated = false
        this.files.forEach(e => e.updated = false)

        writeFileSync(filePath, writer.buffer.slice(0, file_size))
    }

    calculateSearchDividerAndSlope() {
        const file_count = this.files.length
        const hashSearchDivider = Math.floor(0xFFFFFFFF / file_count)
        let hashSearchSlop = 0

        for (hashSearchSlop = 0; hashSearchSlop < file_count; hashSearchSlop++) {
            const matches = this.files.filter(e => this.hash_search(hashSearchDivider, hashSearchSlop, e.id) !== -1)

            if (matches.length == file_count) break
        }

        return { hashSearchDivider, hashSearchSlop }
    }

    hash_search(hashSearchDivider, hashSearchSlope, fileId) {
        let fileIdDivided = Math.floor(fileId / hashSearchDivider)
        let searchAt = 0
    
        if (hashSearchSlope < fileIdDivided)
            searchAt = (fileIdDivided - hashSearchSlope) >>> 0
    
        fileIdDivided += hashSearchSlope + 1
    
        let numFiles = Math.min(this.files.length, fileIdDivided)
    
        let index = searchAt
        searchAt = (numFiles - index) >>> 0
        let i = searchAt
    
        while (i > 0) {
            i = Math.floor(searchAt / 2)
    
            if (this.files[index + i].id < fileId) {
                index += i + 1
                i = (searchAt - 1 - i) >>> 0
            }
    
            searchAt = i
        }
    
        if (index < this.files.length && this.files[index].id === fileId) {
            return index
        }
    
        return -1
    }
    
    /**
     * Update the package file using the current list of files and their include_in_pkg flags
     */
    updatePackageFile() {
        // Get current paths listed in the package file
        const pkg_files = this.package_igz.fixups.TSTR.data.filter(e => e.includes('.'))
        let unmatched = pkg_files.slice()
        let updated = false

        // Update which files are included
        for (const file of this.files) {
            const path = file.path.toLowerCase()
            const existsInPKG = pkg_files.includes(path)

            if (existsInPKG)
                unmatched.splice(unmatched.indexOf(path), 1)

            if (file.include_in_pkg && !existsInPKG) {
                updated = true
                pkg_files.push(path)
            }
            else if (!file.include_in_pkg && existsInPKG) {
                updated = true
                pkg_files.splice(pkg_files.indexOf(path), 1)
            }
        }

        // Remove deleted files
        unmatched = unmatched.filter(e => !e.startsWith('packages/'))
        if (unmatched.length > 0) {
            for (let i = 0; i < unmatched.length; i++) {
                const index = pkg_files.indexOf(unmatched[i])
                pkg_files.splice(index, 1)
            }
            updated = true
        }

        // Update package file
        if (updated) {
            // Find the type of each file
            const types = pkg_files.map(e => {
                const file = this.files.find(f => e == f.path.toLowerCase())
                let type = file_types[computeHash(e)]

                if (type == null && file.path.endsWith('.igz')) {
                    const igz = IGZ.fromFileInfos(file)
                    type = igz.type
                    console.log('Replaced unknown type:', file.path, 'with', type)
                }
                if (type == null) {
                    console.warn('Unknown file type:', file.path)
                    type = 'igx_entites'
                }

                return type
            })
            if (pkg_files.length != types.length) 
                throw new Error(`Mismatch between file count and types count: ${pkg_files.length} != ${types.length}`)

            const paths_data = new Array(pkg_files.length).fill(0).map((_, i) => ({ path: pkg_files[i], type: types[i] }))
            const new_pkg_data = this.package_igz.updatePKG(paths_data)
            const package_file = this.files.find(e => e.path == this.package_igz.path)
            package_file.data = new_pkg_data
            package_file.size = new_pkg_data.length
            package_file.compression = 0xFFFFFFFF
            package_file.original = false
            package_file.updated = true

            this.package_igz = IGZ.fromFileInfos(package_file)
        }
    }

    /**
     * Import a selection of files from another .pak into this one
     * 
     * @param {Pak} import_pak The .pak to import from
     * @param {int[]} files The indexes of the files to import
     * @param {boolean} import_dependencies Whether to recursively import all dependencies into the current .pak (and package file)
     * @param {function} progress_callback Callback function to update the progress bar
     * @returns The number of files imported
     */
    importFromPak(import_pak, file_ids, import_dependencies = true, progress_callback) {

        let pak_deps = []
        let pkg_deps = []

        const addFileAndDependencies = (file) => {
            // Add file to the current archive
            pkg_deps.push(file.path)
            file.data = file.getUncompressedData()
            file.compression = 0xFFFFFFFF
            file.original = false
            file.updated = true
            this.files.push(file)

            if (!import_dependencies || !file.path.endsWith('.igz')) return

            // Get all IGZ dependencies
            const deps = IGZ.fromFileInfos(file).getDependencies(import_pak)

            const isInCurrentPak = (dep) => this.files.some(e => e.path == dep) || pak_deps.includes(dep)

            // Add new dependencies
            pak_deps.push(...deps.filter(e => !isInCurrentPak(e)))
        }

        // Add each selected file to the current pak
        for (const id of file_ids) {
            const file = import_pak.files[id]
            addFileAndDependencies(file)
        }

        // Iteratively add all dependencies
        while (pak_deps.length > 0 && import_dependencies) {
            const path = pak_deps.pop()
            const file = import_pak.files.find(e => e.path == path)

            if (file == null) {
                console.warn('File not found: ' + path)
                continue
            }

            if (progress_callback) progress_callback(path, pkg_deps.length, pkg_deps.length + pak_deps.length + 1)

            addFileAndDependencies(file)
        }

        this.updated = true

        return pkg_deps.length
    }

    /**
     * Get the original name of the archive from its package file
     * @returns the name of the original .pak file 
     */
    getOriginalArchiveName() {
        return this.package_igz?.path.split('/').pop().replaceAll('.igz', '.pak').replaceAll('_pkg', '')
    }

    /**
     * Find an entry in the StaticCollision.igz dictionary
     * 
     * @param {int} objectHash - Object name hash
     * @param {string} filePath - Object file path
     * @returns {Object | null} - The corresponding entry or null if it doesn't exist
     */
    getCollisionItem(objectHash, filePath) {
        const namespaceHash = computeHash(extractName(filePath))

        if (this.collisionData == null) {
            const staticFileInfos = this.files.find(e => e.path.includes('StaticCollision_') && e.path.endsWith('.igz'))
            this.collisionData = []
            
            if (staticFileInfos) {
                const staticIgz = IGZ.fromFileInfos(staticFileInfos)
                const dict = staticIgz.objects.find(e => e.type == 'CStaticCollisionHashInstanceIdHashTable')
                this.collisionData = dict?.extractCollisionData(staticIgz)
            }
        }

        return this.collisionData.find(e => e.objectHash == objectHash && e.namespaceHash == namespaceHash)
    }

    /**
     * Create a new file in the archive
     * 
     * @param {string} path - The path of the file
     * @param {Uint8Array} data - File content as a byte array
     */
    createFile(path, data) {
        this.files.push(new FileInfos({
            pak: this,
            index: this.files.length,
            data, size: data.length,
            compression: 0xFFFFFFFF,
            path: path,
            full_path: 'temporary/mack/data/win64/output/' + path,
            original: false,
            include_in_pkg: false,
            updated: true
        }))

        this.updated = true
        console.log('File created:', path)
    }

    cloneFile(index) {
        const file = this.files[index]
        const igz = IGZ.fromFileInfos(file)
        const new_data = igz.save()

        const updatePath = (str) => str.slice(0, str.lastIndexOf('.')) + '_Copy' + str.slice(str.lastIndexOf('.'))

        const new_file = new FileInfos({ 
            ...this.files[index],
            size: new_data.length,
            data: new_data,
            compression: 0xFFFFFFFF,
            full_path: updatePath(file.full_path),
            path: updatePath(file.path),
            original: false,
            updated: true,
            include_in_pkg: false
        })

        this.files.push(new_file)
        this.updated = true
    }

    deleteFile(index) {
        this.files.splice(index, 1)
        this.updated = true
    }

    replaceFileWithinPak(index1, index2) {
        this.files[index1].size = this.files[index2].size
        this.files[index1].compression = this.files[index2].compression
        this.files[index1].data = this.files[index2].data.slice()

        this.files[index1].original = this.files[index2].original && this.files[index1].path == this.files[index2].path
        this.files[index1].updated = true
        this.updated = true
    }

    toNodeTree() {
        const total_size = this.files.reduce((acc, e) => acc + e.size, 0)
        const tree = []

        // For each file in the archive
        for (let i = 0; i < this.files.length; i++) {
            let folders = this.files[i].full_path.split('/') // List of folders from the path
            let fileName = folders.pop()
            
            let parent = null
            let folderPath = folders[0]
            let parentFolders = []

            // Create and update parent folders in the tree
            for (let j = 0; j < folders.length; j++) {
                let node = tree.find(e => e.path == folderPath)
                
                if (node == null) {
                    // Create an empty folder if it doesn't exist
                    node = { 
                        text: folders[j] + '/', 
                        path: folderPath,
                        type: 'folder',
                        file_count: 0,
                        size: 0,
                        children: [],
                        updated: false
                    }
                    tree.push(node)
                }

                if (parent != null) {
                    // Add the folder to its parent if it's not already there
                    if (!parent.children.includes(node)) {
                        parent.children.push(node)
                    }
                    
                    node.parent = parent
                    parent.file_count++
                    parent.size += this.files[i].size
                }

                parentFolders.push(node)

                // Go to the next (child) folder
                folderPath += '/' + folders[j+1]
                parent = node
            }

            // Add the file as a child of the last folder
            parent.children.push({
                text: fileName + (this.files[i].updated ? '*' : ''),
                type: 'file',
                fileIndex: i
            })
            parent.file_count++
            parent.size += this.files[i].size
            parentFolders.forEach(e => e.updated = e.updated || this.files[i].updated)
        }

        // Update sizes and sort children
        tree.forEach(e => {
            e.size = formatSize(e.size) + ` (${(e.size / total_size * 100).toFixed(2)}%)`
            e.children = e.children.sort((a, b) => a.text.localeCompare(b.text))
        })

        let root = tree[0]

        // Concatenate root single child folders
        while (root.children?.length == 1 && root.children[0].type == 'folder') {
            root.children[0].text = root.text + root.children[0].text
            root = root.children[0]
        }

        return [ root ]
    }
}

export default Pak