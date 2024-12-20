import { bitRead, bitReplace } from "../../utils"
import { createElm } from "./utils/utils"
import ObjectView from "./object_view"
import { ENUMS_METADATA, getAllInheritedChildren } from "./utils/metadata"
import { HAVOK_METADATA } from "../../havok/hkObject"

// Keep track of updated fields within objects
const updated_data = {}

// Load expanded/collapsed fields states
const collapsed_fields = JSON.parse(localStorage.getItem('collapsed_fields') ?? '{}')

class ObjectField {
    /**
     * Instance of a single field in an igObject/hkObject (ObjectView instance)
     * Manages the creation and update of the field DOM element.
     * Updates the corresponding data in the igObject when the input is changed.
     * 
     * Extremely hacky, one class should not handle every single field type!
     */
    constructor(props) {
        this.object   = props.object   // Parent igObject in the .igz file
        this.index    = props.index    // Field index in the parent igObject

        this.name     = props.name     // Field name
        this.type     = props.type     // Field type
        this.offset   = props.offset   // Field offset in the parent object
        this.size     = props.size     // Field size in bytes

        this.bitfield = props.bitfield // (igBitfield) Whether the field is a bitfield children
        this.bits     = props.bits     // (igBitfield) Size in bits
        this.shift    = props.shift    // (igBitfield) Shift amount (offset in bits)
        
        this.bitfieldParent = props.bitfieldParent // (igBitfield) Whether the field contains bitfield children
        this.parent   = props.parent   // (igBitfield, igMemoryRef) Parent field
        this.children = props.children // (igBitfield, igMemoryRef) Child fields

        this.refType  = props.refType  // (igObjectRef)       Reference type
        this.enumType = props.enumType // (igEnum)            Enum type
        this.elmType  = props.elmType  // (igVectorMetaField) Element type
        
        this.memType  = props.memType            // (igMemoryRef, igVectorMetaField) Memory type
        this.element_size  = null                // (igMemoryRef) Size of each element
        this.memory_size   = null                // (igMemoryRef) Total size of the memory
        this.element_count = props.element_count // (igMemoryRef, Vec2f, Vec3f, Vec4f, Matrix44f, Quaternionf) Number of elements in the field
        this.memory_active = props.memory_active ?? false // (igMemoryRef, igRawRef) Whether the memory is active (known from its bitfield)
        this.ref_object    = props.ref_object             // (igMemoryRef, igRawRef) Object containing the MemoryRef's data
        this.ref_data_offset = props.ref_data_offset      // (igMemoryRef, igRawRef) Data start offset relative to the ref_object

        this.interesting = false    // Whether the field can have multiple values between different objects

        this.onChange    = null     // Callback function when the field value is updated
        this.element     = null     // Field DOM element
        this.typeElement = null     // Field type DOM element
        this.input       = null     // Field input DOM element(s)
        this.hexCells    = []       // Corresponding cells DOM elements in the hex view
        this.colorized   = null     // Whether the field is colorized (true, false = force, null = default)
        this.collapsable = props.collapsable || this.bitfieldParent // Whether the field can be collapsed (parent field)
        this.collapsed   = false    // Whether the field is collapsed (parent + children field)

        // HKX specific
        this.value = props.value   // Optional value read during initialization
        this.method = props.method // Type specific read/write method
    }

    // Create the field DOM element (name, type and input cells)
    createField({onChange, onHover, onSelect}) {
        const row  = createElm('tr', 'field-view')
        
        this.element = row
        this.onChange = onChange

        // Create name cell
        const name = this.createNameCell()
        name.style.borderRight = '0.25px solid #555'
        name.onclick = onSelect

        // Create type cell
        const type = createElm('td')
        type.title = this.getTypeTitle()
        type.style.fontStyle = this.children ? 'italic' : ''
        type.style.borderRight = '0.25px solid #555'
        type.innerText = this.getPrettyType()
        type.classList.add(this.getColorClass())
        type.onclick = onSelect
        this.typeElement = type

        // Create input cell
        const data = this.createInputCell()

        // Add border
        if (!this.parent)
            row.style.borderTop = '0.5px solid #555'
        else if (this.parent.children.indexOf(this) == this.parent.children.length - 1) 
            row.style.borderBottom = '0.85px solid #aaa'

        // Style collapsable fields
        if (this.parent?.collapsable) row.classList.add('list-element')
        if (this.collapsable) row.classList.add('collapsable')
        else if (this.collapsed) row.style.display = 'none'

        // Add MemoryRef click event
        if (this.isMemoryType() && this.memory_active && this.element_count > 0) {
            name.onclick = () => this.onMemoryRefClick()
            type.onclick = () => this.onMemoryRefClick()
            name.style.cursor = 'pointer'
            type.style.cursor = 'pointer'
        }

        row.onmouseover = onHover
        row.appendChild(name)
        row.appendChild(type)
        row.appendChild(data)
        return row
    }

    // Create the field name cell
    createNameCell() {
        const name = createElm('td')
        const title = `${this.name} | Offset: 0x${this.offset.toString(16).toUpperCase()} ` // Text displayed on hover
                    + `| Size: ${this.bits ?? this.size} ${this.bits ? 'bit' : 'byte'}${(this.bits ?? this.size) > 1 ? 's' : ''}`
        name.title = title
        name.style.fontStyle = this.children ? 'italic' : ''
        name.style.paddingLeft = '4px'

        // Name refresh callback (when the field is updated)
        this.refreshNameStyle = () => {
            const updated = this.isUpdated()
            name.style.fontWeight = updated ? 400 : 100
            name.style.color = updated ? 'orange' : this.interesting ? '#ff7271' : ''
            name.innerHTML = this.name + (updated ? '*' : '')
        }

        if (this.collapsable) {
            name.style.borderLeft = '4px solid #aaa'
        }
        else if (this.parent) {
            name.style.borderLeft = '1px solid #aaa'
            name.style.paddingLeft = '20px'
        }
        
        this.refreshNameStyle()

        return name
    }

    // Text to display when hovering the type cell
    getTypeTitle() {
        if (Main.treeMode == 'hkx') return this.getTypeTitleHkx()
        let title = `Type: ${this.type}`
        const additionalType = this.memType ?? this.refType ?? this.enumType
        if (additionalType) title += ' | ' + additionalType
        if (this.bitfield)  title += ` | Bits: ${this.bits}, Shift: ${this.shift}`
        if (this.memory_size) title += ` | Memory Size: ${this.memory_size}`
        return title
    }

    getTypeTitleHkx() {
        let title = `Type: ${this.type}`
        const additionalType = this.memType ?? this.enumType
        if (additionalType) title += ' | ' + additionalType
        if (this.refType) title += ` | ${this.refType}`
        return title
    }

    // Create the field input cell
    createInputCell() {
        const cell = createElm('td', '', { textAlign: 'center' })

        let input = null

        try {
            // IGZ/HKX shared input fields
            if (this.isMemoryType() || this.isMemoryTypeHkx())    this.createMemoryInput(cell)
            else if (this.children != null && this.collapsable)   this.createCollapsableInput(cell)

            // HKX specific input fields
            else if (Main.treeMode == 'hkx')              input = this.createHkxInput()

            // IGZ specific input fields
            else if (this.type == 'igRawRefMetaField')            this.createRawRefInput(cell)
            else if (this.type == 'igFloatMetaField')     input = this.createFloatInput()
            else if (this.type == 'igBoolMetaField')      input = this.createCheckboxInput()
            else if (this.type == 'igEnumMetaField')      input = this.createEnumInput()
            else if (this.type == 'igObjectRefMetaField') input = this.createObjectRefInput()
            else if (this.type == 'igHandleMetaField')    input = this.createHandleInput()
            else if (this.isIntegerType())                input = this.createIntegerInput()
            else if (this.isMultiFloatType())             input = this.createMultiFloatInput()
            else if (this.isStringType())                 input = this.createStringInput()
            else input = this.createIntegerInput()

            if (input) {
                if (!this.input) {
                    this.input = input
                    input.onchange ??= () => this.onChange(input.value)
                }
                cell.appendChild(input)
            }
        } catch (e) {
            cell.innerText = '### Error ###'
            cell.style.color = '#ff6341'
            cell.title = e.message
            console.warn('Error creating input cell:', this, e)
        }

        return cell
    }

    createHkxInput() {
        const input = createElm('input')
        let value = this.value

        if (this.isMultiFloatTypeHkx()) {
            return this.createMultiFloatInput() 
        }
        else if (this.type == 'TYPE_STRINGPTR') {
            value ??= this.object.view.readUInt(this.offset)
        }
        else if (this.refType != null) {
            if (value == null) value = 'null'
            else if (HAVOK_METADATA.types[this.refType] == null) {
                value = 'No metadata'
                console.warn(`Metadata not found: ${this.refType}`)
            }
            else {
                const object = Main.hkx.objects.find(e => e.offset == value)
                if (object == null) value = 'Not found: ' + value
                else {
                    value = object.getDisplayName()
                    this.createFocusEvent(object)
                }
            }
        }
        else if (this.type == 'TYPE_ENUM') {
            const value = this.object.view['read' + this.method](this.offset)
            const enums = HAVOK_METADATA.enums[this.enumType]

            if (enums != null) {
                const names = enums.map(e => e.name)
                const selected = enums.find(e => e.value == value).name
                const input = this.createCustomListInput([names], selected, false)
                this.colorized = ['none', 'invalid', 'default', 'ignore'].every(e => !selected.toLowerCase().includes(e))
                return input
            }

            console.warn(`Enum type not found: ${this.enumType}`)
            input.value = value
        }
        else {
            value ??= this.object.view['read' + this.method](this.offset)
        }

        input.value = value
        return input
    }

    createCollapsableInput(cell) {
        const expandText   = `Expand ${this.children.length} items (+)`
        const collapseText = `Click to collapse`
        const savedState = collapsed_fields[this.object.type]
        this.collapsed = savedState == null || savedState[this.offset] == null ? this.children.length > 10 : savedState[this.offset]
        
        const toggleCollapse = () => {
            this.collapsed = !this.collapsed
            cell.innerText = this.collapsed ? expandText : collapseText
            cell.style.fontWeight = this.collapsed ? 400 : 100
            this.children.forEach(e => {
                e.collapsed = this.collapsed
                e.element.style.display = this.collapsed ? 'none' : ''
            })
            updateCollapsedState(this.object.type, this.offset, this.collapsed)
        }

        cell.innerText = this.collapsed ? expandText : collapseText
        cell.style.fontWeight = this.collapsed ? 400 : 100
        cell.style.cursor = 'pointer'
        cell.onclick = () => toggleCollapse()

        if (this.collapsed) {
            this.collapsed = true
            this.children.forEach(e => e.collapsed = true)
        }
    }

    createCheckboxInput() {
        const input = createElm('input')
        input.type = 'checkbox'

        const method = {1: 'UInt8', 2: 'UInt16', 4: 'UInt'}[this.size] ?? 'UInt8'

        let value = this.object.view['read' + method](this.offset)
        if (this.bits) value = bitRead(value, this.bits, this.shift)

        input.checked = value == 1
        input.onchange = () => this.onChange(input.checked ? 1 : 0)
        return input
    }

    createIntegerInput() {
        const input = createElm('input')
        const type = this.getIntegerMethod() ?? 'Int'

        let value = this.object.view['read' + type](this.offset)
        if (this.bits) value = bitRead(value, this.bits, this.shift)

        input.value = value
        return input
    }

    createFloatInput(offset = 0) {
        const input = createElm('input')
        const value = this.object.view.readFloat(this.offset + offset)
        input.value = value.toFixed(3)
        return input
    }

    createMultiFloatInput() {
        const div = createElm('div', 'vec-input')
        const groupBy4 = this.type == 'igMatrix44fMetaField' || this.type == 'igQuaternionfMetaField' || this.type == 'TYPE_TRANSFORM'

        if      (this.type == 'igFloatArrayMetaField') div.style.flexDirection = 'column'
        else if (this.type == 'igMatrix44fMetaField' || this.type == 'TYPE_TRANSFORM')  div.style.flexWrap = 'wrap'

        this.element_count = this.size / 4
        this.input = []

        for (let i = 0; i < this.element_count; i++) {
            const input = this.createFloatInput(i * 4)
            if (groupBy4) input.style.width = '24%'
            input.onchange = () => this.onChange(input.value, i)
            div.appendChild(input)
            this.input.push(input)
        }

        return div
    }

    createCustomListInput([short_names, full_names], selected, include_none = true) {
        const input = createElm('select', 'data-type-select')

        if (short_names.length > 500 && this.parent?.element_count > 100) {
            const option = createElm('option')
            option.innerText = selected
            input.appendChild(option)
            const option2 = createElm('option')
            option2.innerText = `--- Too many options (${short_names.length}) ---`
            input.appendChild(option2)
            return input
        }

        // Add default option
        if (include_none) {
            const option = createElm('option')
            const defaultText = '--- None ---'
            option.innerText = defaultText
            input.appendChild(option)
        }

        // Add all options
        for (let i = 0; i < short_names.length; i++) {
            const option = createElm('option')
            option.innerText = short_names[i]
            input.appendChild(option)
        }

        // Change option names on focus/unfocus
        function setOptionNames(prev_names, new_names, close = false) {
            const id = prev_names.indexOf(input.value);
            [].forEach.call(this.options, function(o, i) {
                o.style.textAlign = close ? 'center' : 'left' // Center on close, left on open
                if (i == 0) return                            // Skip the default option
                o.textContent = new_names[i - 1]              // Set new option text
            })
            if (id >= 0) input.value = new_names[id]          // Set the selected option
        }

        // Set selected option
        input.selectedIndex = selected == null ? 0 : (short_names.indexOf(selected) + (include_none ? 1 : 0))

        if (full_names != null) {
            input.onfocus  = setOptionNames.bind(input, short_names, full_names, false)
            input.onblur   = setOptionNames.bind(input, full_names, short_names, true)
        }

        return input
    }

    createStringInput() {
        const tstr = Main.igz.fixups.TSTR?.data ?? []
        const tstr_index = this.object.view.readInt(this.offset)
        const inRSTT = this.object.fixups.RSTT.includes(this.offset)
        const input = this.createCustomListInput([tstr], inRSTT ? tstr[tstr_index] : null)

        input.style.color = inRSTT ? '' : '#bbb'
        this.colorized = inRSTT
        input.onchange = () => {
            const newRSTT = input.value != '--- None ---'
            this.object.activateFixup('RSTT', this.offset, newRSTT)
            input.style.color = newRSTT ? '' : '#bbb'
            this.onChange(Math.max(0, tstr.indexOf(input.value)))
        }

        return input
    }

    createEnumInput() {
        let value = this.object.view.readInt(this.offset)
        if (this.bits) value = bitRead(value, this.bits, this.shift)
        const enums = ENUMS_METADATA[this.enumType]

        if (enums == null) {
            console.warn(`Enum type not found: ${this.enumType}`)
            return this.createIntegerInput()
        } else {
            const names = enums.map(e => e.name)
            const selected = enums.find(e => e.value == value).name
            const input = this.createCustomListInput([names], selected, false)
            input.onchange = () => {
                this.onChange(enums.find(e => e.name == input.value)?.value ?? 0)
            }
            this.colorized = ['none', 'invalid', 'default'].every(e => !selected.toLowerCase().includes(e))
            return input
        }
    }

    createObjectRefInput() {
        const inROFS = this.object.fixups.ROFS.includes(this.offset)
        const inRNEX = this.object.fixups.RNEX.includes(this.offset)
        const inREXT = this.object.fixups.REXT.includes(this.offset)

        this.colorized = inROFS || inRNEX || inREXT
        let input

        if (inRNEX || inREXT) { 
            const fixup   = inRNEX ? 'RNEX' : 'REXT'
            const index   = this.object.view.readInt(this.offset)
            const data    = inRNEX ? Main.igz.named_externals : Main.igz.fixups.EXID.data

            const mapName = (type) => (name, id) => ({ name: name[0].toString(), path: name[1].toString(), id, type })
            const names       = data.map(mapName(fixup))
            const short_names = names.map(e => `${e.path.slice(e.path.lastIndexOf('/') + 1)}::${e.name}`)
            const full_names  = names.map(e => `|${e.type}| ${e.path} :: ${e.name}`)

            input = this.createCustomListInput([short_names, full_names], short_names[index])
            input.onchange = () => this.onChange(full_names.indexOf(input.value))
            this.typeElement.innerText += ` (${fixup})`
            this.typeElement.title += ` | ${fixup}`
        }
        else {
            const offset = this.object.view.readInt(this.offset)
            const refObject = offset > 0 ? Main.igz.findObject(offset) : null
            const inheritedClasses = getAllInheritedChildren(this.refType).add(this.refType)
            let names = Main.igz.objects.filter(e => !this.refType || inheritedClasses.has(e.type)).map(e => e.getDisplayName())
            
            if (inROFS && !names.includes(refObject?.getDisplayName())) {
                console.warn('Object hierarchy mismatch:', offset, refObject?.getDisplayName())
                names = Main.igz.objects.map(e => e.getDisplayName())
            }
            
            input = this.createCustomListInput([names], refObject?.getDisplayName())
            input.onchange = () => {
                const newObject = Main.igz.objects.find(e => e.getDisplayName() == input.value)
                const newROFS = newObject != null
                this.object.activateFixup('ROFS', this.offset, newROFS, newObject, 0)
                input.style.color = newROFS ? '' : '#bbb'
                this.onChange(newObject?.offset ?? 0)
                this.createFocusEvent(newObject)
            }
            if (inROFS) {
                this.typeElement.title += ` | ROFS`
                this.createFocusEvent(refObject)
            }
        }

        input.style.color = this.colorized ? '' : '#bbb'
        return input
    }

    createHandleInput() {
        const exid = Main.igz.fixups.EXID?.data ?? []

        const inRHND = this.object.fixups.RHND.includes(this.offset)
        const index = this.object.view.readInt(this.offset) >>> 0
        const isHandle = index & 0x80000000

        const mapName = (type) => (name, id) => ({ name: name[0], path: name[1], id, type })
        const names = !inRHND ? Main.igz.named_handles.map(mapName('EXNM')).concat(exid.map(mapName('EXID'))) 
                              : isHandle ? Main.igz.named_handles.map(mapName('EXNM')) : exid.map(mapName('EXID'))
        const short_names = names.map(e => `${typeof(e) == 'string' ? e.path.slice(e.path.lastIndexOf('/') + 1) : e.path}::${e.name}`)
        const full_names  = names.map(e => `|${e.type}| ${e.path} :: ${e.name}`)

        // Handle ID => name index
        const decodeIndex = (index) => {
            const fixup = index & 0x80000000 ? 'EXNM' : 'EXID'
            const nameIndex = names.findIndex(e => e.type == fixup && e.id == (index & 0x3FFFFFFF))

            // Create focus event for EXNM handles inside the same igz file
            if (names[nameIndex].type == 'EXNM') {
                const object = Main.igz.objects.find(e => e.name == names[nameIndex].name)
                if (object != null) this.createFocusEvent(object)
            }

            return short_names[nameIndex]
        }

        // Name index => Handle ID
        const encodeIndex = (name) => {
            const name_id = full_names.indexOf(name)

            input.style.color = name_id != -1 ? '' : '#bbb'

            if (name_id == -1) {
                this.object.activateFixup('RHND', this.offset, false)
                return 0
            }

            let fixup_id = names[name_id].id
            if (names[name_id].type === 'EXNM') {
                fixup_id |= 0x80000000
                
                // Create focus event for EXNM handles inside the same igz file
                const object = Main.igz.objects.find(e => e.name == names[name_id].name)
                if (object != null) this.createFocusEvent(object)
            }

            this.object.activateFixup('RHND', this.offset, true, fixup_id)

            return fixup_id
        }

        const value = inRHND ? decodeIndex(index) : '--- None ---'
        const input = this.createCustomListInput([short_names, full_names], value)

        this.colorized = inRHND
        input.style.color = this.colorized ? '' : '#bbb'
        input.onchange = () => this.onChange(encodeIndex(input.value))

        return input
    }

    createMemoryInput(cell) {
        // Create collapsable input if the field has children
        if (this.children != null && this.collapsable) {
            this.createCollapsableInput(cell)
        }
        // Otherwise, display info about the memory
        else {
            if (this.memType == 'void') {
                cell.innerText = this.memory_active
                    ? `Raw bytes | Size: ${this.memory_size}`
                    : 'Inactive'
            }
            else if (this.memory_active)
                cell.innerText = `Elm. Size: ${this.element_size} | Count: ${this.element_count} (Size: ${this.memory_size})`
            else if (this.element_count > 0)
                cell.innerText = `Inactive | (${this.element_count})`
            else 
                cell.innerText = 'Inactive'
        }

        this.colorized = this.memory_active
    }

    createRawRefInput(cell) {
        const dataOffset = this.object.view.readUInt(this.offset)
        if (dataOffset == 0) return cell.innerText = 'Inactive'

        const object = Main.igz.findObject(dataOffset)
        if (object == null) return cell.innerText = `${dataOffset} (Not found)`

        this.ref_object      = object   
        this.ref_data_offset = Main.igz.getGlobalOffset(dataOffset) - object.global_offset
        this.memory_active   = true

        cell.innerText = this.object == object 
            ? `this + 0x${this.ref_data_offset.toString(16).toUpperCase()}`
            : cell.innerText = object.getDisplayName()
    }

    // Goto the referenced object and focus the corresponding cell in the hex view
    onMemoryRefClick() {
        const refCell = Main.objectView.hexCells.find(e => e.offset == this.children[0].offset)

        if (refCell) {
            Main.objectView.setSelected(refCell.fields[0], refCell, true)
            refCell.element.scrollIntoViewIfNeeded()
        }
        else console.warn('Memory reference not found:', this.name)
    }

    createFocusEvent(object) {
        if (object == null) return

        const focus = () => {
            Main.objectView = new ObjectView(object)
            Main.focusObject(object.index)
        }

        this.typeElement.onclick = focus
        this.typeElement.style.cursor = 'pointer'
        this.typeElement.innerText = this.typeElement.innerText.replace(' ⇒', '') + ' ⇒'
        this.typeElement.classList.add('object-references')
    }

    updateObject(object, value, update_input = false, id = 0) {
        let previous_value = null
        let new_value = null

        let parentObject = object
        let offset = this.offset

        if (this.parent?.isMemoryType()) {
            // Hack for memory ref children update
            object = this.ref_object
            offset = this.ref_data_offset
        }

        const relativeCalculation = (type, id) => {
            const readMethod = 'read' + type
            const writeMethod = 'set' + type
            const dataOffset = offset + (id ?? 0) * 4
            const isLong = this.isLongType()

            previous_value = object.view[readMethod](dataOffset)
            if (isLong) previous_value = BigInt(previous_value)

            // Extract number from input string
            let num = isLong 
                ? BigInt(value.replace(/[^\d.-]/g, ''))
                : Number(value.replace(',', '.').replace(/[^\d.-]/g, ''))

            // Perform relative calculation
            if (value.startsWith('+') || value.startsWith('-=')) num = previous_value + num
            else if (value.startsWith('*')) num = previous_value * num
            else if (value.startsWith('/')) num = previous_value / num

            object.view[writeMethod](num, dataOffset)
            new_value = object.view[readMethod](dataOffset)

            if (type === 'Float') {
                previous_value = previous_value.toFixed(3)
                new_value = new_value.toFixed(3)
            }
        }

        const updateState = (parentObject, index, previous_value, new_value, id) => {
            addUpdatedData(parentObject.index, index, previous_value, new_value, id)

            // Update object's node name in tree view
            parentObject.updated = Object.keys(updated_data[parentObject.index] ?? {}).length > 0
            const node = Main.tree.available().find(e => e.objectIndex == parentObject.index)
            Main.setNodeUpdatedStateIGZ(node, parentObject.updated)
        }  

        if (this.bitfield) 
        {
            if (this.type == 'igBoolMetaField') {
                const previous = object.view.readUInt(offset)
                value = bitReplace(previous, value, 1, this.shift)
                object.view.setUInt(value, offset)
                previous_value = bitRead(previous, 1, this.shift)
                new_value = bitRead(value, 1, this.shift)
                update_input = false
            }
            else if (this.isIntegerType() || this.type == 'igEnumMetaField') {
                const method = this.getIntegerMethod()
                const previous = object.view['read' + method](offset)
                const toSigned = (x) => (x << (32 - this.bits)) >> (32 - this.bits)

                value = parseInt(value) >>> 0
                value = bitReplace(previous, value, this.bits, this.shift)
                object.view['set' + method](value, offset)

                previous_value = bitRead(previous, this.bits, this.shift)
                new_value = bitRead(value, this.bits, this.shift)

                if (!method.startsWith('U')) {
                    previous_value = toSigned(previous_value)
                    new_value = toSigned(new_value)
                }
            }
            else throw new Error('Invalid bitfield type: ' + this.type)
        }
        else if (this.isIntegerType())
        {
            const method = this.getIntegerMethod()
            relativeCalculation(method)
        }
        else if (this.type == 'igFloatMetaField' || this.isMultiFloatType())
        {
            relativeCalculation('Float', id)
        }
        else if (this.type == 'igBoolMetaField') 
        {
            previous_value = object.view.readByte(offset)
            object.view.setByte(value, offset)
            new_value = value
            update_input = false
        }
        else if (this.isDropdownType())
        {
            previous_value = object.view.readInt(offset)
            if (previous_value == 0 && this.isStringType()) previous_value = -1
            object.view.setInt(value, offset)
            new_value = value
            update_input = false
        }

        if (update_input) {
            const input = this.input[id] ?? this.input
            input.value = new_value
            input.blur()
        }

        updateState(parentObject, this.index, previous_value, new_value, id)
    }

    isUpdated(id) {
        const object = this.parent?.object ?? this.object
        if (updated_data[object.index] == null) return false
        if (updated_data[object.index][this.index] == null) return false
        if (id != null && updated_data[object.index][this.index][id] == null) return false
        return true
    }

    getTypeSize(type) {
        const size = {
            'igBoolMetaField':          1,
            'igCharMetaField':          1,
            'igUnsignedCharMetaField':  1,
            'igShortMetaField':         2,
            'igUnsignedShortMetaField': 2,
            'igIntMetaField':           4,
            'igUnsignedIntMetaField':   4,
            'igFloatMetaField':         4,
            'igEnumMetaField':          4,
            'igTimeMetaField':          4,
            'igLongMetaField':          8,
            'igUnsignedLongMetaField':  8,
            'igObjectRefMetaField':     8,
            'igStringMetaField':        8,
            'igHandleMetaField':        8,
            'igStructMetaField':        8,
            'igRawRefMetaField':        8,
            'igSizeTypeMetaField':      8,
            'DotNetDataMetaField':      8,
            'ChunkFileInfoMetaField':   8,
            'igVec2fMetaField':         8,
            'igVec3fMetaField':         12,
            'igVertexElementMetaField': 12,
            'igVec4fMetaField':         16,
            'igNameMetaField':          16,
            'igMatrix44fMetaField':     64,
        }[type]

        if (size == null) console.warn('Unknown type size:', type)
        return size ?? 8
    }

    getIntegerMethod(type) {
        return {
            'igLongMetaField':          'Long',
            'igUnsignedLongMetaField':  'ULong',
            'igIntMetaField':           'Int',
            'igUnsignedIntMetaField':   'UInt',
            'igShortMetaField':         'Int16',
            'igUnsignedShortMetaField': 'UInt16',
            'igCharMetaField':          'Int8',
            'igUnsignedCharMetaField':  'UInt8',
            'igEnumMetaField':          'Int',
            'igBoolMetaField':          'UInt8',
        }[type ?? this.type]
    }

    isIntegerType(type) {
        return [
            'igLongMetaField',
            'igUnsignedLongMetaField',
            'igIntMetaField',
            'igUnsignedIntMetaField',
            'igShortMetaField',
            'igUnsignedShortMetaField',
            'igCharMetaField',
            'igUnsignedCharMetaField',
        ].includes(type ?? this.type)
    }

    isMultiFloatType() {
        return [
            'igVec2fMetaField',
            'igVec3fMetaField',
            'igVec4fMetaField',
            'igQuaternionfMetaField',
            'igMatrix44fMetaField',
            'igFloatArrayMetaField',
        ].includes(this.type)
    }

    isDropdownType() {
        return [
            'igEnumMetaField',
            'igStringMetaField',
            'igNameMetaField',
            'igHandleMetaField',
            'igObjectRefMetaField',
        ].includes(this.type)
    }

    isStringType(type) {
        return [
            'igStringMetaField',
            'igNameMetaField',
            'ChunkFileInfoMetaField'
        ].includes(type ?? this.type)
    }

    isMemoryType() {
        return [
            'igMemoryRefMetaField',
            'igVectorMetaField',
        ].includes(this.type)
    }

    isLongType() {
        return [
            'igLongMetaField',
            'igUnsignedLongMetaField',
        ].includes(this.type)
    }

    isMemoryTypeHkx() {
        return [
            'TYPE_ARRAY',
            'TYPE_RELARRAY'
        ].includes(this.type)
    }

    isMultiFloatTypeHkx() {
        return [
            'TYPE_VECTOR4',
            'TYPE_QUATERNION',
            'TYPE_TRANSFORM'
        ].includes(this.type)
    }

    // Returns the css color class for the field type
    getColorClass() {
        if (Main.treeMode == 'hkx') return this.getColorClassHkx()

        if (this.bitfieldParent) return null

        if (this.type == 'igBoolMetaField')      return 'hex-bool'
        if (this.type == 'igEnumMetaField')      return 'hex-enum'
        if (this.type == 'igFloatMetaField')     return 'hex-float'
        if (this.type == 'igObjectRefMetaField') return 'hex-child'
        if (this.isLongType())                   return 'hex-long'
        if (this.isIntegerType())                return 'hex-int'
        if (this.isMultiFloatType())             return 'hex-vec'
        if (this.isMemoryType() ||
            this.type == 'igRawRefMetaField')    return 'hex-mem'
        if (this.isStringType() ||
            this.type == 'igHandleMetaField')    return 'hex-string'
    }

    getColorClassHkx() {
        if (this.type == 'TYPE_BOOL' || this.type == 'TYPE_FLAGS' || 
            this.type == 'hkBitField')                                 return 'hex-bool'
        if (this.type == 'TYPE_ENUM')                                  return 'hex-enum'
        if (this.type == 'TYPE_REAL' || this.type == 'TYPE_HALF')      return 'hex-float'
        if (this.type == 'TYPE_POINTER' || this.type == 'TYPE_STRUCT') return 'hex-child'
        if (this.type.includes('INT') || this.type == 'TYPE_SHORT')    return 'hex-int'
        if (this.isMultiFloatTypeHkx())                                return 'hex-vec'
        if (this.isMemoryTypeHkx())                                    return 'hex-mem'
        if (this.type == 'TYPE_STRINGPTR')                             return 'hex-string'
    }

    // Return a prettified string version of the field type
    getPrettyType(type) {
        if (Main.treeMode == 'hkx') return this.getPrettyTypeHkx()

        type ??= this.enumType ?? this.refType ?? this.type

        if (type == null) return "Type Error"

        // Remove 'ig' and 'MetaField', unless it's actually igMetaField
        if (type != 'igMetaField') {
            if (type.startsWith('ig')) type = type.slice(2)
            if (type.endsWith('MetaField')) type = type.slice(0, -9)
        }

        // Add bit count
        if (this.bits && this.type !== 'igBoolMetaField') type += ` (${this.bits})`

        // Add space between camel case
        if      (this.enumType) type = type.split('.').pop()
        else if (!this.refType) type = type.replace(/(?<=[a-z])(?=[A-Z][a-z])/g, ' ')

        return type
    }

    getPrettyTypeHkx() {
        const isUppercase = (str) => str.split('').every(e => e == e.toUpperCase())

        let type = this.enumType ?? this.memType ?? this.refType ?? this.type
        type = type.replace('TYPE_', '') // Remove 'TYPE_' prefix

        if (type == 'REAL') type = 'Float' // Real -> Float 
        else if (isUppercase(type)) type = type[0] + type.slice(1).toLowerCase() // UPPER -> Upper

        // Add memory/list prefix
        if (this.type == 'TYPE_ARRAY') type = `Memory<${type}>`
        else if (this.memType != null) type = `List<${type}>`

        return type.replace('ptr', 'Ptr').replace('array', 'Array')
    }
}

/**
 * Update collapsed fields state and save to local storage
 * 
 * @param {string} object - object type
 * @param {int} offset - field offset
 * @param {boolean} collapsed - new state
 */
function updateCollapsedState(object, offset, collapsed) {
    collapsed_fields[object] ??= {}

    if (collapsed_fields[object][offset] == null)
        collapsed_fields[object][offset] = collapsed
    else
        delete collapsed_fields[object][offset]

    localStorage.setItem('collapsed_fields', JSON.stringify(collapsed_fields))
}

/**
 * Store the data as updated for the given object and field.
 * If the value is the same as the original, remove it from the updated data.
 * @param {int} object - object index
 * @param {int} field - field index
 * @param {int|string} originalValue - previous value
 * @param {int|string} value - new value
 * @param {int} id - element index
*/
function addUpdatedData(object, field, originalValue, value, id = 0) {
    if (updated_data[object] == null)
        updated_data[object] = {}

    if (updated_data[object][field] == null)
        updated_data[object][field] = []

    if (updated_data[object][field][id] == null)
        updated_data[object][field][id] = originalValue

    if (updated_data[object][field][id] == value) {
        delete updated_data[object][field][id]
        
        if (updated_data[object][field].every(e => e == null))
            delete updated_data[object][field]
    }
}

/**
 * Clear all updated data
 */
function clearUpdatedData() {
    for (const index in updated_data) {
        delete updated_data[index]
    }
}

export default ObjectField
export {
    clearUpdatedData
}