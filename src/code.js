"use strict";

var Class = require("rtl.js").Class;
var Type = require("js/Types.js");

var NullCodeGenerator = Class.extend({
	init: function NullCodeGenerator(){},
	write: function(){},
    openScope: function(){},
    closeScope: function(){},
    getResult: function(){}
});

exports.Generator = Class.extend({
	init: function CodeGenerator(){
		this.__result = "";
		this.__indent = "";
	},
	write: function(s){
		this.__result += s.replace(/\n/g, "\n" + this.__indent);
	},
	openScope: function(){
		this.__indent += "\t";
		this.__result += "{\n" + this.__indent;
	},
	closeScope: function(ending){
		this.__indent = this.__indent.substr(1);
		this.__result = this.__result.substr(0, this.__result.length - 1) + "}";
		if (ending)
			this.write(ending);
		else
			this.write("\n");
	},
	getResult: function(){return this.__result;}
});

exports.SimpleGenerator = Class.extend({
	init: function SimpleCodeGenerator(code){this.__result = code ? code : "";},
	write: function(s){this.__result += s;},
	result: function(){return this.__result;}
});

var Expression = Class.extend({
	init: function Expression(code, type, designator, constValue, maxPrecedence){
        this.__code = code;
        this.__type = type;
        this.__designator = designator;
        this.__constValue = constValue;
        this.__maxPrecedence = maxPrecedence;
    },
    code: function(){return this.__code;},
    lval: function(){return this.__designator ? this.__designator.lval() : this.__code;},
    type: function(){return this.__type;},
    designator: function(){return this.__designator;},
    constValue: function(){return this.__constValue;},
    maxPrecedence: function(){return this.__maxPrecedence;},
    isTerm: function(){return !this.__designator && this.__maxPrecedence === undefined;},
    deref: function(){
        if (!this.__designator)
            return this;
        if (this.__type instanceof Type.Array || this.__type instanceof Type.Record)
            return this;
        var info = this.__designator.info();
        if (!(info instanceof Type.VariableRef))
            return this;
        return new Expression(this.__code + ".get()", this.__type);
    },
    ref: function(){
        if (!this.__designator)
            return this;
        
        var info = this.__designator.info();
        if (info instanceof Type.VariableRef)
            return this;

        return new Expression(this.__designator.refCode(), this.__type);
    }
});

function adjustPrecedence(e, precedence){
    var code = e.code();
    if (e.maxPrecedence() > precedence)
        code = "(" + code + ")";
    return code;
}

function genExport(symbol){
    if (symbol.isVariable())
        return "function(){return " + symbol.id() + ";}";
    if (symbol.isType()){
        var type = symbol.info().type();
        if (!(type instanceof Type.Record 
              || (type instanceof Type.Pointer && !Type.typeName(Type.pointerBase(type)))))
            return undefined;
    }
    return symbol.id();
}

var ModuleGenerator = Class.extend({
    init: function Code$ModuleGenerator(name, imports){
        this.__name = name;
        this.__imports = imports;
    },
    prolog: function(){
        var result = "";            
        var modules = this.__imports;
        for(var name in modules){
            var alias = modules[name];
            if (result.length)
                result += ", ";
            result += alias;
        }
        return "var " + this.__name + " = function " + "(" + result + "){\n";
    },
    epilog: function(exports){
        var result = "";
        for(var access in exports){
            var e = exports[access];
            var code = genExport(e);
            if (code){
                if (result.length)
                    result += ",\n";
                result += "\t" + e.id() + ": " + code;
            }
        }
        if (result.length)
            result = "return {\n" + result + "\n}\n";
        
        result += "}(";

        var modules = this.__imports;
        var importList = "";
        for(var name in modules){
            if (importList.length)
                importList += ", ";
            importList += name;
        }
        result += importList;
        result += ");\n";

        return result;
    }
});

exports.nullGenerator = new NullCodeGenerator();
exports.Expression = Expression;
exports.adjustPrecedence = adjustPrecedence;
exports.genExport = genExport;
exports.ModuleGenerator = ModuleGenerator;
