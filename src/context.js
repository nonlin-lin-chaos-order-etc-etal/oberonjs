"use strict";

var Cast = require("js/Cast.js");
var Code = require("js/Code.js");
var CodeGenerator = require("js/CodeGenerator.js");
var ConstValue = require("js/ConstValue.js");
var ContextExpression = require("js/ContextExpression.js");
var ContextHierarchy = require("js/ContextHierarchy.js");
var Designator = require("js/Designator.js");
var Errors = require("js/Errors.js");
var Expression = require("js/Expression.js");
var Module = require("js/Module.js");
var op = require("js/Operator.js");
var ObContext = require("js/Context.js");
var Parser = require("parser.js");
var Procedure = require("js/Procedure.js");
var Record = require("js/Record.js");
var Class = require("rtl.js").Class;
var Scope = require("js/Scope.js");
var Symbol = require("js/Symbols.js");
var Type = require("js/Types.js");
var TypeId = require("js/TypeId.js");
var Variable = require("js/Variable.js");

var basicTypes = Type.basic();
var nullCodeGenerator = CodeGenerator.nullGenerator();
var nilType = Type.nil();
/*
function log(s){
    console.info(s);
}
*/

var ChainedContext = ContextHierarchy.Node;
ChainedContext.extend = Class.extend;
ChainedContext.prototype.init = ContextHierarchy.Node;

exports.BaseType = ChainedContext.extend({
    init: function BaseTypeContext(context){
        ChainedContext.prototype.init.call(this, context);
    },
    handleQIdent: function(q){
        var s = ContextHierarchy.getQIdSymbolAndScope(this.root(), q);
        this.parent().setBaseType(ContextExpression.unwrapType(s.symbol().info()));
    }
});

exports.QualifiedIdentificatorModule = ChainedContext.extend({
    init: function QualifiedIdentificatorModule(context){
        ChainedContext.prototype.init.call(this, context);
        this.__id = undefined;
    },
    handleIdent: function(id){
        this.__id = id;
    },
    endParse: function(){
        var found = this.root().findSymbol(this.__id);
        if (!found)
            return false;
        var s = found.symbol();
        if (!s || !s.isModule())
            return false;
        this.parent().handleModule(this.__id, s.info());
    }
});

exports.QualifiedIdentificator = ChainedContext.extend({
    init: function QualifiedIdentificator(context){
        ChainedContext.prototype.init.call(this, context);
        this.__module = undefined;
        this.__id = undefined;
        this.__code = "";
    },
    handleIdent: function(id){
        this.__id = id;
    },
    handleModule: function(id, module){
        this.__module = module;
        this.__code = id + ".";
    },
    endParse: function(){
        var code = this.__code ? this.__code + Record.mangleJSProperty(this.__id) : this.__id;
        this.parent().handleQIdent({
            module: this.__module,
            id: this.__id,
            code: code
        });
    }
});

exports.Identdef = ChainedContext.extend({
    init: function IdentdefContext(context){
        ChainedContext.prototype.init.call(this, context);
        this._id = undefined;
        this._export = false;
    },
    handleIdent: function(id){this._id = id;},
    handleLiteral: function(){this._export = true;},
    endParse: function(){
        this.parent().handleIdentdef(this._makeIdendef());
    },
    _makeIdendef: function(){
        return new ObContext.IdentdefInfo(this._id, this._export);
    }
});

function makeContext(context){
    var l = context.root().language();
    return {
        types: l.types, 
        rtl: l.rtl, 
        qualifyScope: context.qualifyScope.bind(context)
        };
    }

exports.Designator = ChainedContext.extend({
    init: function Context$Designator(context){
        ChainedContext.prototype.init.call(this, context);
        this.__currentType = undefined;
        this.__info = undefined;
        this.__scope = undefined;
        this.__code = "";
        this.__lval = undefined;
        this.__indexExpression = undefined;
        this.__derefCode = undefined;
        this.__propCode = undefined;
    },
    handleQIdent: function(q){
        var found = ContextHierarchy.getQIdSymbolAndScope(this.root(), q);
        this.__scope = found.scope();
        var s = found.symbol();
        var info = s.info();
        var code = q.code;
        if (info instanceof Type.Type || s.isType())
            this.__currentType = info;
        else if (s.isConst())
            this.__currentType = Type.constType(info);
        else if (s.isVariable()){
            this.__currentType = info.type();
            if (q.module)
                code += "()";
        }
        else if (s.isProcedure()){
            this.__currentType = Type.procedureType(info);
            code = this.__currentType.designatorCode(code);
        }
        
        this.__info = info;
        this.__code += code;
    },
    handleIdent: function(id){
        var t = this.__currentType;
        var isReadOnly = this.__info instanceof Type.Variable 
                      && this.__info.isReadOnly();
        if (t instanceof Record.Pointer){
            this.__handleDeref();
            isReadOnly = false;
        }
        var field = t.denote(id, isReadOnly);
        var currentType = field.type();
        var language = this.root().language();
        var cx = makeContext(this);
        var fieldCode = field.designatorCode(this.__code, cx);
        this.__derefCode = fieldCode.derefCode;
        this.__propCode = fieldCode.propCode;
        this._advance(currentType, field.asVar(this.__code, isReadOnly, cx), fieldCode.code, undefined, true);
        this.__scope = undefined;
    },
    _currentType: function(){return this.__currentType;},
    _currentInfo: function(){return this.__info;},
    _discardCode: function(){this.__code = "";},
    _makeDerefVar: function(info){
        return new Variable.DerefVariable(this.__currentType, this.__code);
    },
    handleExpression: function(e){this.__indexExpression = e;},
    __handleIndexExpression: function(){
        var e = this.__indexExpression;
        this._checkIndexType(e.type());
        var index = this._indexSequence(this.__info, this.__derefCode, Expression.deref(e).code());
        this._checkIndexValue(index, e.constValue());  
        return index;
    },
    _checkIndexType: function(type){
        if (!Type.isInt(type))
            throw new Errors.Error(
                Type.intsDescription() + " expression expected, got '" + type.description() + "'");
    },        
    _checkIndexValue: function(index, pValue){
        if (!pValue)
            return;

        var value = pValue.value;
        Code.checkIndex(value);
        
        var length = index.length;
        if ((this.__currentType instanceof Type.StaticArray || this.__currentType instanceof Type.String)
         && value >= length)
            throw new Errors.Error("index out of bounds: maximum possible index is "
                                 + (length - 1)
                                 + ", got " + value );
    },
    _advance: function(type, info, code, lval, replace){
        this.__currentType = type;
        this.__info = info;
        this.__code = (replace ? "" : this.__code) + code;
        this.__lval = lval;
    },
    _indexSequence: function(info, code, indexCode){
        var type = this._currentType();
        var isArray = type instanceof Type.Array;
        if (!isArray && !(type instanceof Type.String))
            throw new Errors.Error("ARRAY or string expected, got '" + type.description() + "'");

        var length = isArray ? type instanceof Type.StaticArray ? type.length() 
                                                                : undefined
                             : Type.stringLen(type);
        if (!isArray && !length)
            throw new Errors.Error("cannot index empty string" );
        var indexType = isArray ? Type.arrayElementsType(type) : basicTypes.ch;

        var leadCode = code;
        code = code + "[" + indexCode + "]";
        var lval;
        if (indexType == basicTypes.ch){
            lval = code;
            code = this._stringIndexCode();
        }

        return { length: length,
                 type: indexType,
                 info: new Variable.PropertyVariable(indexType, leadCode, indexCode, info instanceof Type.Const || info.isReadOnly(), this.root().language().rtl),
                 code: code,
                 lval: lval,
                 asProperty: indexCode
               };
    },
    _stringIndexCode: function(){
        return this.__derefCode + ".charCodeAt(" + Expression.deref(this.__indexExpression).code() + ")";
    },
    handleLiteral: function(s){
        if (s == "]" || s == ","){
            var index = this.__handleIndexExpression();
            this.__propCode = index.asProperty;
            this._advance(index.type, index.info, this.__code + index.code, index.lval);
        }
        if (s == "[" || s == ","){
            this.__derefCode = this.__code;
            this.__code = "";
        }
        else if (s == "^"){
            this.__handleDeref();
            this.__info = this._makeDerefVar(this.__info);
        }
    },
    __handleDeref: function(){
        if (!(this.__currentType instanceof Record.Pointer))
            throw new Errors.Error("POINTER TO type expected, got '"
                                 + this.__currentType.description() + "'");
        this.__currentType = Record.pointerBase(this.__currentType);
        if (this.__currentType instanceof Record.NonExported)
            throw new Errors.Error("POINTER TO non-exported RECORD type cannot be dereferenced");
        this.__lval = undefined;
    },
    handleTypeCast: function(type){
        ContextExpression.checkTypeCast(this.__info, this.__currentType, type, "type cast");

        var code = this.root().language().rtl.typeGuard(this.__code, ContextExpression.castCode(type, this));
        this.__code = code;

        this.__currentType = type;
    },
    endParse: function(){
        var code = this.__code;
        this.parent().attributes.designator =
            new Designator.Type(code, this.__lval ? this.__lval : code, this.__currentType, this.__info, this.__scope);
    }
});

exports.Type = ChainedContext.extend({
    init: function Context$Type(context){
        ChainedContext.prototype.init.call(this, context);
    },
    handleQIdent: function(q){
        this.parent().handleQIdent(q);
    }
});

var HandleSymbolAsType = ChainedContext.extend({
    init: function Context$HandleSymbolAsType(context){
        ChainedContext.prototype.init.call(this, context);
    },
    handleQIdent: function(q){
        var s = ContextHierarchy.getQIdSymbolAndScope(this.root(), q);
        this.setType(ContextExpression.unwrapType(s.symbol().info()));
    }
});

exports.FormalType = HandleSymbolAsType.extend({
    init: function FormalType(context){
        HandleSymbolAsType.prototype.init.call(this, context);
        this.__arrayDimension = 0;
    },
    setType: function(type){           
        for(var i = 0; i < this.__arrayDimension; ++i)
            type = new (this.root().language().types.OpenArray)(type);
        this.parent().setType(type);

    },
    handleLiteral: function(s){
        if (s == "ARRAY")
            ++this.__arrayDimension;
    }
});

var ProcArg = Class.extend({
    init: function(type, isVar){
        this.type = type;
        this.isVar = isVar;
    },
    description: function(){
        return (this.isVar ? "VAR " : "") + this.type.description();
    }
});

function AddArgumentMsg(name, arg){
    this.name = name;
    this.arg = arg;
}

exports.FormalParameters = ChainedContext.extend({
    init: function FormalParametersContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__arguments = [];
        this.__result = undefined;

        var parent = this.parent();
        var name = parent.typeName();
        if (name === undefined)
            name = "";
        this.__type = new Procedure.Type(name);
        parent.setType(this.__type);
    },
    handleMessage: function(msg){
        if (msg instanceof AddArgumentMsg){
            this.__arguments.push(msg.arg);
            return undefined;
        }
        return ChainedContext.prototype.handleMessage.call(this, msg);
    },
    handleQIdent: function(q){
        var s = ContextHierarchy.getQIdSymbolAndScope(this.root(), q);
        var resultType = ContextExpression.unwrapType(s.symbol().info());
        this._checkResultType(resultType);
        this.__result = resultType;
    },
    endParse: function(){
        this.__type.define(this.__arguments, this.__result);
    },
    _checkResultType: function(type){
        if (type instanceof Type.Array)
            throw new Errors.Error("the result type of a procedure cannot be an ARRAY");
        if (type instanceof Type.Record)
            throw new Errors.Error("the result type of a procedure cannot be a RECORD");
    }
});

function endParametersMsg(){}

exports.FormalParametersProcDecl = exports.FormalParameters.extend({
    init: function FormalParametersProcDeclContext(context){
        exports.FormalParameters.prototype.init.call(this, context);
    },
    handleMessage: function(msg){
        var result = exports.FormalParameters.prototype.handleMessage.call(this, msg);
        if (msg instanceof AddArgumentMsg)
            this.parent().handleMessage(msg);
        return result;
    },
    endParse: function(){
        exports.FormalParameters.prototype.endParse.call(this);
        this.handleMessage(endParametersMsg);
    }
});

exports.ProcDecl = ChainedContext.extend({
    init: function ProcDeclContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__id = undefined;
        this.__firstArgument = true;
        this.__type = undefined;
        this.__returnParsed = false;
        var root = this.root();
        this.__outerScope = root.currentScope();
        this.__stdSymbols = root.language().stdSymbols;
    },
    handleIdentdef: function(id){
        this.__id = id;
        this.codeGenerator().write(this._prolog());
        this.root().pushScope(Scope.makeProcedure(this.__stdSymbols));
    },
    handleIdent: function(id){
        if (this.__id.id() != id)
            throw new Errors.Error("mismatched procedure names: '" + this.__id.id()
                                 + "' at the begining and '" + id + "' at the end");
    },
    _prolog: function(){
        return "\nfunction " + this.__id.id() + "(";
    },
    _epilog: function(){
        return "";
    },
    _beginBody: function(){
        this.codeGenerator().openScope();
    },
    typeName: function(){return undefined;},
    setType: function(type){
        var procSymbol = new Symbol.Symbol(
            this.__id.id(), 
            new Type.ProcedureId(type));
        this.__outerScope.addSymbol(procSymbol, this.__id.exported());
        this.__type = type;
    },
    __addArgument: function(name, arg){
        if (name == this.__id.id())
            throw new Errors.Error("argument '" + name + "' has the same name as procedure");
        var v = this._makeArgumentVariable(arg, name);
        var s = new Symbol.Symbol(name, v);
        this.root().currentScope().addSymbol(s);

        var code = this.codeGenerator();
        if (!this.__firstArgument)
            code.write(", ");
        else
            this.__firstArgument = false;
        code.write(name + "/*" + arg.description() + "*/");
    },
    _makeArgumentVariable: function(arg, name){
        return new Variable.ArgumentVariable(name, arg.type, arg.isVar);
    },
    handleMessage: function(msg){
        if (msg == endParametersMsg){
            this.codeGenerator().write(")");
            this._beginBody();
            return;
        }
        if (msg instanceof AddArgumentMsg)
            return this.__addArgument(msg.name, msg.arg);
        return ChainedContext.prototype.handleMessage.call(this, msg);
    },
    handleReturn: function(e){
        var type = e.type();
        var result = this.__type.result();
        if (!result)
            throw new Errors.Error("unexpected RETURN in PROCEDURE declared with no result type");
        
        var language = this.root().language();
        var op;
        if (language.types.implicitCast(type, result, false, {set: function(v){op = v;}, get:function(){return op;}}))
            throw new Errors.Error(
                "RETURN '" + result.description() + "' expected, got '"
                + type.description() + "'");

        this.codeGenerator().write("return " + op.clone(language, e) + ";\n");

        this.__returnParsed = true;
    },
    endParse: function(){
        this.codeGenerator().closeScope(this._epilog());
        this.root().popScope();

        var result = this.__type.result();
        if (result && !this.__returnParsed)
            throw new Errors.Error("RETURN expected at the end of PROCEDURE declared with '"
                                 + Type.typeName(result) + "' result type");
    }
});

exports.Return = ChainedContext.extend({
    init: function Context$Return(context){
        ChainedContext.prototype.init.call(this, context);
    },
    codeGenerator: function(){return nullCodeGenerator;},
    handleExpression: function(e){
        this.parent().handleReturn(e);
    }
});

exports.ProcParams = HandleSymbolAsType.extend({
    init: function Context$ProcParams(context){
        HandleSymbolAsType.prototype.init.call(this, context);
        this.__isVar = false;
        this.__argNamesForType = [];
    },
    handleLiteral: function(s){
        if (s == "VAR")
            this.__isVar = true;
    },
    handleIdent: function(id){ this.__argNamesForType.push(id);},
    setType: function(type){
        var names = this.__argNamesForType;
        for(var i = 0; i < names.length; ++i){
            var name = names[i];
            this.handleMessage(
                new AddArgumentMsg(name, new Type.ProcedureArgument(type, this.__isVar)));
        }
        this.__isVar = false;
        this.__argNamesForType = [];
    }
});

function ForwardTypeMsg(id){
    this.id = id;
}

exports.PointerDecl = ChainedContext.extend({
    init: function Context$PointerDecl(context){
        ChainedContext.prototype.init.call(this, context);
    },
    handleQIdent: function(q){
        var id = q.id;
        var s = q.module
              ? ContextHierarchy.getModuleSymbolAndScope(q.module, q.id)
              : this.root().findSymbol(id);
        
        var info = s ? s.symbol().info()
                     : this.parent().handleMessage(new ForwardTypeMsg(id));
        var typeId = ContextExpression.unwrapTypeId(info);
        this.__setTypeId(typeId);
    },
    __setTypeId: function(typeId){
        if (!(typeId instanceof TypeId.Forward)){
            var type = typeId.type();
            if (!(type instanceof Type.Record))
                throw new Errors.Error(
                    "RECORD is expected as a POINTER base type, got '" + type.description() + "'");
        }

        var parent = this.parent();
        var name = parent.isAnonymousDeclaration() 
            ? ""
            : parent.genTypeName();
        var pointerType = new Record.Pointer(name, typeId);
        parent.setType(pointerType);
    },
    setType: function(type){
        var typeId = new TypeId.Type(type);
        this.root().currentScope().addFinalizer(function(){Record.stripTypeId(typeId);});
        this.__setTypeId(typeId);
    },
    isAnonymousDeclaration: function(){return true;},
    exportField: function(field){
        throw new Errors.Error( "cannot export anonymous RECORD field: '" + field + "'");
    }
});

exports.ArrayDecl = HandleSymbolAsType.extend({
    init: function Context$ArrayDecl(context){
        HandleSymbolAsType.prototype.init.call(this, context);
        this.__dimensions = undefined;
    },
    handleDimensions: function(dimensions){this.__dimensions = dimensions;},
    setType: function(elementsType){
        var type = elementsType;
        var dimensions = "";
        for(var i = this.__dimensions.length; i-- ;){
            var length = this.__dimensions[i];
            dimensions = length + (dimensions.length ? ", " + dimensions : "");
            var arrayInit = i ? undefined
                              : this._makeInit(elementsType, dimensions, length);
            type = this._makeType(type, arrayInit, length);
        }

        this.__type = type;
    },
    isAnonymousDeclaration: function(){return true;},
    endParse: function(){this.parent().setType(this.__type);},
    _makeInit: function(type, dimensions, length){
        var rtl = this.root().language().rtl;
        if (type == basicTypes.ch)
            return rtl.makeCharArray(dimensions);

        var initializer = type instanceof Type.Array || type instanceof Type.Record
            ? "function(){return " + type.initializer(this) + ";}"
            : type.initializer(this);
        return rtl.makeArray(dimensions + ", " + initializer);
    },
    _makeType: function(elementsType, init, length){
        return new (this.root().language().types.StaticArray)(init, elementsType, length);
    }
});

exports.ArrayDimensions = ChainedContext.extend({
    init: function ArrayDimensionsContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__dimensions = [];
    },
    codeGenerator: function(){return nullCodeGenerator;},
    handleExpression: function(e){
        var type = e.type();
        if (type !== basicTypes.integer)
            throw new Errors.Error("'INTEGER' constant expression expected, got '" + type.description() + "'");
        var value = e.constValue();
        if (!value)
            throw new Errors.Error("constant expression expected as ARRAY size");
        if (value.value <= 0)
            throw new Errors.Error("array size must be greater than 0, got " + value.value);
        this._addDimension(value.value);
    },
    endParse: function(){
        this.parent().handleDimensions(this.__dimensions);
    },
    _addDimension: function(size){
        this.__dimensions.push(size);
    }
});

var relationOps = new ContextExpression.RelationOps();

function checkSetHasBit(leftType, rightType, context){
    if (!Type.isInt(leftType))
        throw new Errors.Error(
            Type.intsDescription() + " expected as an element of SET, got '" + Type.typeName(leftType) + "'");
    ContextExpression.checkImplicitCast(context.root(), rightType, basicTypes.set);
}

function relationOp(leftType, rightType, literal, ops, context){
    var type = 
          literal == "IS" ? ContextExpression.unwrapType(rightType)
        : literal == "IN" ? checkSetHasBit(leftType, rightType, context)
                          : ops.coalesceType(leftType, rightType);
    var o;
    var mismatch;
    switch (literal){
        case "=":
            o = ops.eq(type);
            if (!o)
                mismatch = ops.eqExpect();
            break;
        case "#":
            o = ops.notEq(type);
            if (!o)
                mismatch = ops.eqExpect();
            break;
        case "<":
            o = ops.less(type);
            if (!o)
                mismatch = ops.strongRelExpect();
            break;
        case ">":
            o = ops.greater(type);
            if (!o)
                mismatch = ops.strongRelExpect();
            break;
        case "<=":
            o = ops.lessEq(type);
            if (!o)
                mismatch = ops.relExpect();
            break;
        case ">=":
            o = ops.greaterEq(type);
            if (!o)
                mismatch = ops.relExpect();
            break;
        case "IS":
            o = ops.is(type, context);
            break;
        case "IN":
            o = op.setHasBit;
            break;
        }
    if (mismatch)
        ContextExpression.throwOperatorTypeMismatch(literal, mismatch, type);
    return o;
}

function designatorAsExpression(d){
    var info = d.info();
    if (info instanceof Type.ProcedureId){
        var proc = Type.procedureType(info);
        if (proc instanceof Procedure.Std)
            throw new Errors.Error(proc.description() + " cannot be referenced");
        var scope = d.scope();
        if (scope instanceof Scope.Procedure)
            throw new Errors.Error("local procedure '" + d.code() + "' cannot be referenced");
    }

    var value;
    if (info instanceof Type.Const)
        value = info.value;
    return Expression.make(d.code(), d.type(), d, value);
}

exports.Set = ChainedContext.extend({
    init: function SetContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__value = 0;
        this.__expr = "";
    },
    handleElement: function(from, fromValue, to, toValue){
        if (fromValue && (!to || toValue)){
            if (to)
                for(var i = fromValue.value; i <= toValue.value; ++i)
                    this.__value |= 1 << i;
            else
                this.__value |= 1 << fromValue.value;
        }
        else{
            if (this.__expr.length)
                this.__expr += ", ";
            if (to)
                this.__expr += "[" + from + ", " + to + "]";
            else
                this.__expr += from;
        }
    },
    endParse: function(){
        var parent = this.parent();
        if (!this.__expr.length)
            parent.handleConst(basicTypes.set, new ConstValue.Set(this.__value), this.__value.toString());
        else{
            var code = this.root().language().rtl.makeSet(this.__expr);
            if (this.__value)
                code += " | " + this.__value;
            var e = Expression.make(code, basicTypes.set);
            parent.handleExpression(e);
        }
    }
});

exports.SetElement = ChainedContext.extend({
    init: function SetElementContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__from = undefined;
        this.__fromValue = undefined;
        this.__to = undefined;
        this.__toValue = undefined;
        this.__expr = CodeGenerator.makeSimpleGenerator();
    },
    codeGenerator: function(){return this.__expr;},
    handleExpression: function(e){
        var value = e.constValue();
        if (!this.__from)
            {
            this.__from = this.__expr.result();
            this.__fromValue = value;
            this.__expr = CodeGenerator.makeSimpleGenerator();
            }
        else{
            this.__to = this.__expr.result();
            this.__toValue = value;
        }
    },
    endParse: function(){
        this.parent().handleElement(this.__from, this.__fromValue, this.__to, this.__toValue);
    }
});

exports.Expression = ChainedContext.extend({
    init: function ExpressionContext(context, relOps){
        ChainedContext.prototype.init.call(this, context);
        this.__relOps = relOps || relationOps;
        this.__relation = undefined;
        this.__expression = undefined;
    },
    handleSimpleExpression: function(e){
        if (!this.__expression){
            this.__expression = e;
            return;
        }

        var leftExpression = this.__expression;
        var rightExpression = e;
        leftExpression = ContextExpression.promoteTypeInExpression(leftExpression, rightExpression.type());
        rightExpression = ContextExpression.promoteTypeInExpression(rightExpression, leftExpression.type());

        var o = this._relationOperation(leftExpression.type(), rightExpression.type(), this.__relation);
        var language = this.root().language();
        this.__expression = o(leftExpression, rightExpression, language);
    },
    _relationOperation: function(left, right, relation){
        return relationOp(left, right, relation, this.__relOps, this);
    },
    handleLiteral: function(relation){
        this.__relation = relation;
    },
    codeGenerator: function(){return nullCodeGenerator;},
    endParse: function(){
        var type = this.__expression.type();
        if (!type)
            throw new Errors.Error("procedure returning no result cannot be used in an expression");

        var parent = this.parent();
        parent.codeGenerator().write(this.__expression.code());
        parent.handleExpression(this.__expression);
    }
});

function handleIfExpression(e){
    var type = e.type();
    if (type !== basicTypes.bool)
        throw new Errors.Error("'BOOLEAN' expression expected, got '" + type.description() + "'");
}
/*
var IfContextBase = ChainedContext.extend({
    init: function(context){
        ChainedContext.prototype.init.call(this, context);
    },
    endParse: function(){
        var gen = this.codeGenerator();
        gen.write(")");
        gen.openScope();
    },
    handleExpression: handleIfExpression
});
*/
exports.If = ChainedContext.extend({
    init: function IfContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.codeGenerator().write("if (");
    },
    handleExpression: function(e){
        handleIfExpression(e);
        var gen = this.codeGenerator();
        gen.write(")");
        gen.openScope();
    },
    handleLiteral: function(s){
        var gen = this.codeGenerator();
        if (s == "ELSIF"){
            gen.closeScope("");
            gen.write("else if (");
        }
        else if (s == "ELSE"){
            gen.closeScope("");
            gen.write("else ");
            gen.openScope();
        }
    },
    endParse: function(){
        this.codeGenerator().closeScope("");
    }
});

exports.emitEndStatement = function(context){
    context.codeGenerator().write(";\n");
};

exports.Case = ChainedContext.extend({
    init: function CaseContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__type = undefined;
        this.__firstCase = true;
        this.__var = this.root().currentScope().generateTempVar("case");
        this.codeGenerator().write("var " + this.__var + " = ");
    },
    caseVar: function(){return this.__var;},
    handleExpression: function(e){
        var type = e.type();
        var gen = this.codeGenerator();
        if (type instanceof Type.String){
            var v;
            if (Type.stringAsChar(type, {set: function(value){v = value;}})){
                gen.write(v);
                type = basicTypes.ch;
            }
        }
        if (!Type.isInt(type) && type != basicTypes.ch)
            throw new Errors.Error(
                Type.intsDescription() + " or 'CHAR' expected as CASE expression");
        this.__type = type;
        gen.write(";\n");
    },
    beginCase: function(){
        if (this.__firstCase)
            this.__firstCase = false;
        else
            this.codeGenerator().write("else ");
    },
    handleLabelType: function(type){
        if (!Cast.areTypesMatch(type, this.__type))
            throw new Errors.Error(
                "label must be '" + Type.typeName(this.__type) + "' (the same as case expression), got '"
                + Type.typeName(type) + "'");
    }
});

exports.CaseLabelList = ChainedContext.extend({
    init: function CaseLabelListContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__glue = "";
    },
    handleLabelType: function(type){this.parent().handleLabelType(type);},
    handleRange: function(from, to){
        var parent = this.parent();
        if (!this.__glue)
            parent.caseLabelBegin();

        var v = parent.parent().caseVar();
        var cond = to === undefined
            ? v + " === " + from.value
            : "(" + v + " >= " + from.value + " && " + v + " <= " + to.value + ")";
        this.codeGenerator().write(this.__glue + cond);
        this.__glue = " || ";
    },
    endParse: function(){this.parent().caseLabelEnd();}
});

exports.CaseLabel = ChainedContext.extend({
    init: function CaseLabelContext(context){
        ChainedContext.prototype.init.call(this, context);
    },
    caseLabelBegin: function(){
        this.parent().beginCase();
        this.codeGenerator().write("if (");
    },
    caseLabelEnd: function(){
        var gen = this.codeGenerator();
        gen.write(")");
        gen.openScope();
    },
    handleLabelType: function(type){this.parent().handleLabelType(type);},
    handleRange: function(from, to){this.parent().handleRange(from, to);},
    endParse: function(){this.codeGenerator().closeScope("");}
});

exports.CaseRange = ChainedContext.extend({
    init: function CaseRangeContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__from = undefined;
        this.__to = undefined;
    },
    codeGenerator: function(){return nullCodeGenerator;}, // suppress any output
    handleLabel: function(type, v){
        this.parent().handleLabelType(type);
        if (this.__from === undefined )
            this.__from = v;
        else
            this.__to = v;
    },
    handleConst: function(type, value){
        if (type instanceof Type.String){
            if (!Type.stringAsChar(type, {set: function(v){value = v;}}))
                throw new Errors.Error("single-character string expected");
            type = basicTypes.ch;
            value = new ConstValue.Int(value);
        }
        this.handleLabel(type, value);
    },
    handleIdent: function(id){
        var s = ContextHierarchy.getSymbol(this.root(), id);
        if (!s.isConst())
            throw new Errors.Error("'" + id + "' is not a constant");
        
        var type = Type.constType(s.info());
        if (type instanceof Type.String)
            this.handleConst(type, undefined);
        else
            this.handleLabel(type, s.info().value);
    },
    endParse: function(){this.parent().handleRange(this.__from, this.__to);}
});

exports.While = ChainedContext.extend({
    init: function WhileContext(context){
        ChainedContext.prototype.init.call(this, context);
        var gen = this.codeGenerator();
        gen.write("while (true)");
        gen.openScope();
        gen.write("if (");
    },
    handleExpression: function WhileContext$handleExpression(e){
        handleIfExpression(e);
        var gen = this.codeGenerator();
        gen.write(")");
        gen.openScope();
    },
    handleLiteral: function(s){
        if (s == "ELSIF"){
            var gen = this.codeGenerator();
            gen.closeScope("");
            gen.write("else if (");
        }
    },
    endParse: function(){
        var gen = this.codeGenerator();
        gen.closeScope(" else break;\n");
        gen.closeScope("");
    }
});

exports.Repeat = ChainedContext.extend({
    init: function RepeatContext(context){
        ChainedContext.prototype.init.call(this, context);
        var gen = context.codeGenerator();
        gen.write("do ");
        gen.openScope();
    }
});

exports.Until = ChainedContext.extend({
    init: function UntilContext(context){
        ChainedContext.prototype.init.call(this, context);
        context.codeGenerator().closeScope(" while (");
    },
    codeGenerator: function(){ return nullCodeGenerator; },
    handleExpression: function(e){
        handleIfExpression(e);
        this.parent().codeGenerator().write( op.not(e).code() );
    },
    endParse: function(){
        this.parent().codeGenerator().write(");\n");
    }
});

exports.For = ChainedContext.extend({
    init: function ForContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__var = undefined;
        this.__initExprParsed = false;
        this.__toExpr = CodeGenerator.makeSimpleGenerator();
        this.__toParsed = false;
        this.__by_parsed = false;
        this.__by = undefined;
    },
    handleIdent: function(id){
        var s = ContextHierarchy.getSymbol(this.root(), id);
        if (!s.isVariable())
            throw new Errors.Error("'" + s.id() + "' is not a variable");
        var type = s.info().type();
        if (type !== basicTypes.integer)
            throw new Errors.Error(
                  "'" + s.id() + "' is a '" 
		+ type.description() + "' variable, 'FOR' control variable must be 'INTEGER'");
        this._handleInitCode(id, "for (" + id + " = ");
    },
    _handleInitCode: function(id, code){
        this.__var = id;
        this.codeGenerator().write(code);
    },
    _handleInitExpression: function(type){
        if (type != basicTypes.integer)
            throw new Errors.Error(
                "'INTEGER' expression expected to assign '" + this.__var
                + "', got '" + type.description() + "'");
        this.__initExprParsed = true;
    },
    handleExpression: function(e){
        var type = e.type();
        if (!this.__initExprParsed)
            this._handleInitExpression(type);
        else if (!this.__toParsed) {
            if (type != basicTypes.integer)
                throw new Errors.Error(
                    "'INTEGER' expression expected as 'TO' parameter, got '" + type.description() + "'");
            this.__toParsed = true;
        }
        else {
            if (type != basicTypes.integer)
                throw new Errors.Error("'INTEGER' expression expected as 'BY' parameter, got '" + type.description() + "'");
            var value = e.constValue();
            if ( value === undefined )
                throw new Errors.Error("constant expression expected as 'BY' parameter");
            this.__by = value.value;
        }
    },
    codeGenerator: function(){
        if (this.__initExprParsed && !this.__toParsed)
            return this.__toExpr;
        if (this.__toParsed && !this.__by_parsed)
            return nullCodeGenerator; // suppress output for BY expression
        
        return this.parent().codeGenerator();
    },
    handleBegin: function(){
        this.__by_parsed = true;

        var relation = this.__by < 0 ? " >= " : " <= ";
        var step = this.__by === undefined
                            ? "++" + this.__var
                            : this.__var + (this.__by < 0
                                    ? " -= " + -this.__by
                                    : " += " +  this.__by);
        var s = "; " + this.__var + relation + this.__toExpr.result() + "; " + step + ")";
        var gen = this.codeGenerator();
        gen.write(s);
        gen.openScope();
    },
    endParse: function(){this.codeGenerator().closeScope("");}
});

exports.emitForBegin = function(context){context.handleBegin();};

exports.CheckAssignment = ChainedContext.extend({
    init: function Context$CheckAssignment(context){
        ChainedContext.prototype.init.call(this, context);
    },
    handleLiteral: function(s){
        if (s == "=")
            throw new Errors.Error("did you mean ':=' (statement expected, got expression)?");
    }
});

exports.ConstDecl = ChainedContext.extend({
    init: function ConstDeclContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__id = undefined;
        this.__type = undefined;
        this.__value = undefined;
    },
    handleIdentdef: function(id){
        this.__id = id;
        this.codeGenerator().write("var " + id.id() + " = ");
    },
    handleExpression: function(e){
        var value = e.constValue();
        if (!value)
            throw new Errors.Error("constant expression expected");
        this.__type = e.type();
        this.__value = value;
    },
    endParse: function(){
        var c = new Type.Const(this.__type, this.__value);
        this.root().currentScope().addSymbol(new Symbol.Symbol(this.__id.id(), c), this.__id.exported());
        this.codeGenerator().write(";\n");
    }
});

function checkIfFieldCanBeExported(name, idents, hint){
    for(var i = 0; i < idents.length; ++i){
        var id = idents[i];
        if (!id.exported())
            throw new Errors.Error(
                "field '" + name + "' can be exported only if " + hint + " '" +
                id.id() + "' itself is exported too");
    }
}

exports.VariableDeclaration = HandleSymbolAsType.extend({
    init: function Context$VariableDeclaration(context){
        HandleSymbolAsType.prototype.init.call(this, context);
        this.__idents = [];
        this.__type = undefined;
    },
    handleIdentdef: function(id){this.__idents.push(id);},
    exportField: function(name){
        checkIfFieldCanBeExported(name, this.__idents, "variable");
    },
    setType: function(type){this.__type = type;},
    type: function(){return this.__type;},
    typeName: function(){return undefined;},
    isAnonymousDeclaration: function(){return true;},
    checkExport: function(){},
    handleMessage: function(msg){
        if (msg instanceof ForwardTypeMsg)
            throw new Errors.Error("type '" + msg.id + "' was not declared");
        return HandleSymbolAsType.prototype.handleMessage.call(this, msg);
    },
    _initCode: function(){
        return this.__type.initializer(this);
    },
    endParse: function(){
        var idents = this.__idents;
        var gen = this.codeGenerator();
        for(var i = 0; i < idents.length; ++i){
            var id = idents[i];
            var varName = id.id();
            if (id.exported())
                this.checkExport(varName);

            var v = new Variable.DeclaredVariable(varName, this.__type);
            this.root().currentScope().addSymbol(new Symbol.Symbol(varName, v), id.exported());
            gen.write("var " + varName + " = " + this._initCode() + ";");
        }

        gen.write("\n");
    }
});

exports.FieldListDeclaration = HandleSymbolAsType.extend({
    init: function Context$FieldListDeclaration(context){
        HandleSymbolAsType.prototype.init.call(this, context);
        this.__idents = [];
        this.__type = undefined;
    },
    typeName: function(){return undefined;},
    handleIdentdef: function(id) {this.__idents.push(id);},
    exportField: function(name){
        checkIfFieldCanBeExported(name, this.__idents, "field");
    },
    setType: function(type) {this.__type = type;},
    isAnonymousDeclaration: function(){return true;},
    endParse: function(){
        var idents = this.__idents;
        var parent = this.parent();
        for(var i = 0; i < idents.length; ++i)
            parent.addField(idents[i], this.__type);
    }
});

function assertProcType(type, info){
    var unexpected;
    if ( !type )
        unexpected = info.idType();
    else if (!(type instanceof Type.Procedure) && !(type instanceof Module.AnyType))
        unexpected = type.description();
    if (unexpected)
        throw new Errors.Error("PROCEDURE expected, got '" + unexpected + "'");
    return type;
}

function assertProcStatementResult(type){
    if (type && !(type instanceof Module.AnyType))
        throw new Errors.Error("procedure returning a result cannot be used as a statement");
}

function beginCallMsg(){}
function endCallMsg(){}

exports.ActualParameters = ChainedContext.extend({
    init: function ActualParametersContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.handleMessage(beginCallMsg);
    },
    handleExpression: function(e){
        this.parent().handleExpression(e);
    },
    endParse: function(){
        this.handleMessage(endCallMsg);
    }
});

function isTypeRecursive(type, base){
    if (type == base)
        return true;
    if (type instanceof Type.Record){
        if (isTypeRecursive(type.base, base))
            return true;
        var fields = type.fields;
        for(var fieldName in fields){
            if (isTypeRecursive(fields[fieldName].type(), base))
                return true;
        }
    }
    else if (type instanceof Type.Array)
        return isTypeRecursive(Type.arrayElementsType(type), base);
    return false;
}

exports.RecordDecl = ChainedContext.extend({
    init: function RecordDeclContext(context, RecordCons){
        ChainedContext.prototype.init.call(this, context);
        var parent = this.parent();
        this.__cons = parent.genTypeName();
        var name = parent.isAnonymousDeclaration() ? "" : this.__cons;
        this.__type = new RecordCons(name, this.__cons, context.root().currentScope());
        parent.setType(this.__type);
    },
    type: function(){return this.__type;},
    addField: function(field, type){
        if (isTypeRecursive(type, this.__type))
            throw new Errors.Error("recursive field definition: '"
                + field.id() + "'");
        this.__type.addField(this._makeField(field, type));
        if (field.exported())
            this.parent().exportField(field.id());
    },
    setBaseType: function(type){
        if (!(type instanceof Type.Record))
            throw new Errors.Error(
                "RECORD type is expected as a base type, got '"
                + type.description()
                + "'");
        if (isTypeRecursive(type, this.__type))
            throw new Errors.Error("recursive inheritance: '"
                + Type.typeName(this.__type) + "'");

        this.__type.setBase(type);
    },
    endParse: function(){
        var gen = this.codeGenerator();
        this.codeGenerator().write(
              this._generateConstructor()
            + this._generateInheritance()
            );
    },
    _generateConstructor: function(){
        var gen = CodeGenerator.makeGenerator();
        gen.write("function " + this.__cons + "()");
        gen.openScope();
        gen.write(this._generateBaseConstructorCallCode() 
                + this.__generateFieldsInitializationCode());
        gen.closeScope("");
        return gen.result();
    },
    _qualifiedBaseConstructor: function(){
        var baseType = this.__type.base;
        if (!baseType)
            return "";
        return this.qualifyScope(baseType.scope) + Type.typeName(baseType);
    },
    _generateBaseConstructorCallCode: function(){
        var baseType = this.__type.base;
        var qualifiedBase = baseType ? this.qualifyScope(baseType.scope) + Type.typeName(baseType) : undefined; 
        var result = this._qualifiedBaseConstructor();
        return result ? result + ".call(this);\n" : "";
    },
    __generateFieldsInitializationCode: function(){
        var result = "";
        var ownFields = this.__type.fields;
        for(var f in ownFields){
            var fieldType = ownFields[f].type();
            result += "this." + Record.mangleField(f) + " = " + fieldType.initializer(this) + ";\n";
        }
        return result;
    },
    _generateInheritance: function(){
        var base = this.__type.base;
        if (!base)
            return "";
        var qualifiedBase = this.qualifyScope(base.scope) + Type.typeName(base); 
        return this.root().language().rtl.extend(this.__cons, qualifiedBase) + ";\n";
    },
    _makeField: function(field, type){
        return new Record.Field(field, type);
    }
});

exports.TypeDeclaration = ChainedContext.extend({
    init: function TypeDeclarationContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__id = undefined;
        this.__symbol = undefined;
    },
    handleIdentdef: function(id){
        var typeId = new TypeId.Lazy();
        var symbol = new Symbol.Symbol(id.id(), typeId);
        var scope = this.root().currentScope();
        scope.addSymbol(symbol, id.exported());
        if (!id.exported())
            scope.addFinalizer(function(){Record.stripTypeId(typeId);});
        this.__id = id;
        this.__symbol = symbol;
    },
    setType: function(type){
        TypeId.define(this.__symbol.info(), type);
        Scope.resolve(this.root().currentScope(), this.__symbol);
    },
    typeName: function(){return this.__id.id();},
    id: function(){return this.__id;},
    genTypeName: function(){return this.__id.id();},
    isAnonymousDeclaration: function(){return false;},
    type: function(){return this.parent().type();},
    exportField: function(name){
        checkIfFieldCanBeExported(name, [this.__id], "record");
    }
});

exports.TypeSection = ChainedContext.extend({
    init: function TypeSection(context){
        ChainedContext.prototype.init.call(this, context);
    },
    handleMessage: function(msg){
        if (msg instanceof ForwardTypeMsg){
            var scope = this.root().currentScope();
            Scope.addUnresolved(scope, msg.id);
            var resolve = function(){
                return ContextHierarchy.getSymbol(this.root(), msg.id).info().type();
            }.bind(this);

            return new TypeId.Forward(resolve);
        }
        return ChainedContext.prototype.handleMessage.call(this, msg);
    },
    endParse: function(){
        var unresolved = Scope.unresolved(this.root().currentScope());
        if (unresolved.length)
            throw new Errors.Error("no declaration found for '" + unresolved.join("', '") + "'");
    }
});

exports.TypeCast = ChainedContext.extend({
    init: function TypeCastContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__type = undefined;
    },
    handleQIdent: function(q){
        var s = ContextHierarchy.getQIdSymbolAndScope(this.root(), q);
        s = s.symbol();
        if (!s.isType())
            return; // this is not a type cast, may be procedure call
        this.__type = s.info().type();
    },
    endParse: function(){
        if (this.__type === undefined)
            return false;
        this.parent().handleTypeCast(this.__type);
        return true;
    }
});

exports.ModuleDeclaration = ChainedContext.extend({
    init: function ModuleDeclarationContext(context){
        ChainedContext.prototype.init.call(this, context);
        this.__name = undefined;
        this.__imports = {};
        this.__moduleScope = undefined;
        this.__moduleGen = undefined;
        this.__stdSymbols = this.root().language().stdSymbols;
    },
    handleIdent: function(id){
        if (this.__name === undefined ) {
            this.__name = id;
            this.__moduleScope = new Scope.Module(id, this.__stdSymbols);
            this.root().pushScope(this.__moduleScope);
        }
        else if (id === this.__name){
            var scope = this.root().currentScope();
            scope.close();
            var exports = scope.exports;
            Scope.defineExports(Scope.moduleSymbol(scope).info(), exports);
            this.codeGenerator().write(this.__moduleGen.epilog(exports));
        }
        else
            throw new Errors.Error("original module name '" + this.__name + "' expected, got '" + id + "'" );
    },
    findModule: function(name){
        if (name == this.__name)
            throw new Errors.Error("module '" + this.__name + "' cannot import itself");
        return this.parent().findModule(name);
    },
    handleImport: function(modules){
        var scope = this.root().currentScope();
        var moduleAliases = {};
        for(var i = 0; i < modules.length; ++i){
            var s = modules[i];
            var name = Type.moduleName(s.info());
            this.__imports[name] = s;
            scope.addSymbol(s);
            moduleAliases[name] = s.id();
        }
        this.__moduleGen = this.root().language().moduleGenerator(
                this.__name,
                moduleAliases);
        this.codeGenerator().write(this.__moduleGen.prolog());
    },
    handleLiteral: function(){},
    qualifyScope: function(scope){
        if (scope != this.__moduleScope && scope instanceof Scope.Module){
            var id = Scope.moduleSymbol(scope).id();
            
            // implicitly imported module, e.g.: record.pointerToRecordFromAnotherModule.field
            // should not be used in code generation, 
            // just return non-empty value to indicate this is not current module
            if (!(id in this.__imports))
                return "module '" + id + "' is not imported";
            return this.__imports[id].id() + ".";
        }
        return "";
    }
});

var ModuleImport = ChainedContext.extend({
    init: function ModuleImport(context){
        ChainedContext.prototype.init.call(this, context);
        this.__import = {};
        this.__currentModule = undefined;
        this.__currentAlias = undefined;
    },
    handleIdent: function(id){
        this.__currentModule = id;
    },
    handleLiteral: function(s){
        if (s == ":=")
            this.__currentAlias = this.__currentModule;
        else if (s == ",")
            this.__handleImport();
    },
    endParse: function(){
        if (this.__currentModule)
            this.__handleImport();

        var modules = [];
        var unresolved = [];
        for(var alias in this.__import){
            var moduleName = this.__import[alias];
            var module = this.parent().findModule(moduleName);
            if (!module)
                unresolved.push(moduleName);
            else
                modules.push(new Symbol.Symbol(alias, module));
        }
        if (unresolved.length)
            throw new Errors.Error("module(s) not found: " + unresolved.join(", "));
        
        this.parent().handleImport(modules);
    },
    __handleImport: function(){
        var alias = this.__currentAlias;
        if (!alias)
            alias = this.__currentModule;
        else
            this.__currentAlias = undefined;
        
        for(var a in this.__import){
            if (a == alias)
                throw new Errors.Error("duplicated alias: '" + alias +"'");
            if (this.__import[a] == this.__currentModule)
                throw new Errors.Error("module already imported: '" + this.__currentModule +"'");
        }
        this.__import[alias] = this.__currentModule;
    }
});
exports.ModuleImport = ModuleImport;

function makeProcCall(context, type, info){
    assertProcType(type, info);
    var l = context.root().language();
    return type.callGenerator(
        { types: l.types, 
          rtl: l.rtl, 
          qualifyScope: context.qualifyScope.bind(context)
        });
}

exports.AddArgumentMsg = AddArgumentMsg;
exports.assertProcStatementResult = assertProcStatementResult;
exports.beginCallMsg = beginCallMsg;
exports.endCallMsg = endCallMsg;
exports.Chained = ChainedContext;
exports.designatorAsExpression = designatorAsExpression;
exports.endParametersMsg = endParametersMsg;
exports.makeProcCall = makeProcCall;
exports.HandleSymbolAsType = HandleSymbolAsType;
exports.makeContext = makeContext;