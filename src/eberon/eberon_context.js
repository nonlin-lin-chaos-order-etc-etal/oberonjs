"use strict";

var Cast = require("cast.js");
var Context = require("context.js");
var Errors = require("js/Errors.js");
var Type = require("type.js");

var MethodType = Type.Procedure.extend({
    init: function(type){
        Type.Procedure.prototype.init.call(this);
        this.__type = type;
    },
    args: function(){return this.__type.args();},
    result: function(){return this.__type.result();},
    description: function(){return this.__type.description();}
});

var ProcOrMethodId = Context.Chained.extend({
    init: function EberonContext$ProcOrMethodId(parent){
        Context.Chained.prototype.init.call(this, parent);
        this.__maybeTypeId = undefined;
        this.__type = undefined;
    },
    handleIdent: function(id){this.__maybeTypeId = id;},
    handleLiteral: function(s){
        var type = Context.getTypeSymbol(this, this.__maybeTypeId);
        if (!(type instanceof Type.Record))
            throw new Errors.Error(
                  "RECORD type expected in method declaration, got '"
                + type.description() + "'");
        this.__type = type;
    },
    handleIdentdef: function(id){
        this.parent().handleMethodOrProc(id, this.__type);
    }
});

var ProcOrMethodDecl = Context.ProcDecl.extend({
    init: function EberonContext$ProcOrMethodDecl(parent){
        Context.ProcDecl.prototype.init.call(this, parent);
        this.__boundType = undefined;
        this.__methodId = undefined;
        this.__methodType = undefined;
        this.__isNew = undefined;
        this.__endingId = undefined;
    },
    handleMethodOrProc: function(id, type){
        if (type){
            this.__boundType = type;
            this.__methodId = id;
        }

        Context.ProcDecl.prototype.handleIdentdef.call(
            this,
            type ? new Context.IdentdefInfo(type.name() + "." + id.id(),
                                            id.exported()) 
                 : id
            );
    },
    setType: function(type){
        Context.ProcDecl.prototype.setType.call(this, type);
        this.__methodType = new MethodType(type);
    },
    handleLiteral: function(s){
        if (s == "NEW"){
            var id = this.__methodId.id();
            var existingField = this.__boundType.findSymbol(id);
            if (existingField)
                throw new Errors.Error(
                      existingField instanceof MethodType
                    ?   "base record already has method '" + id 
                      + "' (unwanted NEW attribute?)"
                    : "cannot declare method, record already has field '" + id + "'");

            this.__boundType.addField(this.__methodId, this.__methodType);
            this.__isNew = true;
        }
    },
    handleIdent: function(id){
        if (this.__boundType){
            if (!this.__endingId)
                this.__endingId = id + ".";
            else {
                Context.ProcDecl.prototype.handleIdent.call(this, this.__endingId + id);
                this.__endingId = undefined;
            }
        }
        else
            Context.ProcDecl.prototype.handleIdent.call(this, id);
    },
    endParse: function(){
        if (this.__boundType){
            if (this.__endingId)
                // should throw
                Context.ProcDecl.prototype.handleIdent.call(this, this.__endingId);

            if (!this.__isNew){
                var base = this.__boundType.baseType();
                var id = this.__methodId.id();
                var existing = base ? base.findSymbol(id) : undefined;
                if (!existing){
                    throw new Errors.Error(
                          "there is no method '" + id 
                        + "' to override in base type(s) of '" 
                        + this.__boundType.name() + "' (NEW attribute is missed?)");
                }
                if (!Cast.areProceduresMatch(existing, this.__methodType))
                    throw new Errors.Error(
                          "overridden method '" + id + "' signature mismatch: should be '"
                        + existing.description() + "', got '" 
                        + this.__methodType.description() + "'");
            }
        }
        Context.ProcDecl.prototype.endParse.call(this);
    }
});

exports.ProcOrMethodId = ProcOrMethodId;
exports.ProcOrMethodDecl = ProcOrMethodDecl;