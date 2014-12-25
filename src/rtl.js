"use strict";

if (typeof Uint16Array == "undefined"){
    GLOBAL.Uint16Array = function(length){
        Array.call(this, length);
        for(var i = 0; i < length; ++i)
            this[i] = 0;
    };
}

function Class(){}
Class.extend = function extend(methods){
        function Type(){
            for(var m in methods)
                this[m] = methods[m];
        }
        Type.prototype = this.prototype;

        var result = methods.init;
        result.prototype = new Type(); // inherit this.prototype
        result.prototype.constructor = result; // to see constructor name in diagnostic
        
        result.extend = extend;
        return result;
    };

var impl = {
    extend: function(cons, base){
        function Type(){}
        Type.prototype = base.prototype;
        cons.prototype = new Type();
        cons.prototype.constructor = cons;
    },
    typeGuard: function(from, to){
        if (!from)
            return from;
        if (!(from instanceof to)){
            var fromStr;
            var toStr;
            
            if (from && from.constructor && from.constructor.name)
                fromStr = "" + from.constructor.name;
            else
                fromStr = "" + from;
            
            if (to.name)
                toStr = "" + to.name;
            else
                toStr = "" + to;
            
            var msg = "typeguard assertion failed";
            if (fromStr || toStr)               
                msg += ": '" + fromStr + "' is not an extension of '" + toStr + "'";
            throw new Error(msg);
        }
        return from;
    },
    getMappedValue: function(map, key){
        if (!map.hasOwnProperty(key))
            throw new Error("invalid key: " + key);
        return map[key];
    },
    makeArray: function(/*dimensions, initializer*/){
        var forward = Array.prototype.slice.call(arguments);
        var result = new Array(forward.shift());
        var i;
        if (forward.length == 1){
            var init = forward[0];
            if (typeof init == "function")
                for(i = 0; i < result.length; ++i)
                    result[i] = init();
            else
                for(i = 0; i < result.length; ++i)
                    result[i] = init;
        }
        else
            for(i = 0; i < result.length; ++i)
                result[i] = this.makeArray.apply(this, forward);
        return result;
    },
    __setupCharArrayMethods: function(a){
        var rtl = this;
        a.charCodeAt = function(i){return this[i];};
        a.slice = function(){
            var result = Array.prototype.slice.apply(this, arguments);
            rtl.__setupCharArrayMethods(result);
            return result;
        };
        a.toString = function(){
            return String.fromCharCode.apply(this, this);
        };
    },
    __makeCharArray: function(length){
        var result = new Uint16Array(length);
        this.__setupCharArrayMethods(result);
        return result;
    },
    makeCharArray: function(/*dimensions*/){
        var forward = Array.prototype.slice.call(arguments);
        var length = forward.pop();

        if (!forward.length)
            return this.__makeCharArray(length);

        function makeArray(){
            var forward = Array.prototype.slice.call(arguments);
            var result = new Array(forward.shift());
            var i;
            if (forward.length == 1){
                var init = forward[0];
                for(i = 0; i < result.length; ++i)
                    result[i] = init();
            }
            else
                for(i = 0; i < result.length; ++i)
                    result[i] = makeArray.apply(undefined, forward);
            return result;
        }

        forward.push(this.__makeCharArray.bind(this, length));
        return makeArray.apply(undefined, forward);
    },
    makeSet: function(/*...*/){
        var result = 0;
        
        function checkBit(b){
            if (b < 0 || b > 31)
                throw new Error("integers between 0 and 31 expected, got " + b);
        }

        function setBit(b){
            checkBit(b);
            result |= 1 << b;
        }
        
        for(var i = 0; i < arguments.length; ++i){
            var b = arguments[i];
            if (b instanceof Array){
                var from = b[0];
                var to = b[1];
                if (from < to)
                    throw new Error("invalid SET diapason: " + from + ".." + to);
                for(var bi = from; bi <= to; ++bi)
                    setBit(bi);
            }
            else
                setBit(b);
        }
        return result;
    },
    makeRef: function(obj, prop){
        return {set: function(v){ obj[prop] = v; },
                get: function(){ return obj[prop]; }};
    },
    setInclL: function(l, r){return (l & r) == l;},
    setInclR: function(l, r){return (l & r) == r;},
    assignArrayFromString: function(a, s){
        var i;
        for(i = 0; i < s.length; ++i)
            a[i] = s.charCodeAt(i);
        for(i = s.length; i < a.length; ++i)
            a[i] = 0;
    },
    strCmp: function(s1, s2){
        var cmp = 0;
        var i = 0;
        while (!cmp && i < s1.length && i < s2.length){
            cmp = s1.charCodeAt(i) - s2.charCodeAt(i);
            ++i;
        }
        return cmp ? cmp : s1.length - s2.length;
    },
    cloneArrayOfRecords: function(from){
        var length = from.length;
        var result = new Array(length);
        if (length){
            var method = from[0] instanceof Array 
                       ? this.cloneArrayOfRecords // this is array of arrays, go deeper
                       : this.cloneRecord;
            for(var i = 0; i < result.length; ++i)
                result[i] = method.call(this, from[i]);
        }
        return result;
    },
    cloneArrayOfScalars: function(from){
        var length = from.length;
        if (!length)
            return [];
        if (!(from[0] instanceof Array))
            return from.slice();

        // this is array of arrays, go deeper
        var result = new Array(length);
        for(var i = 0; i < length; ++i)
            result[i] = this.cloneArrayOfScalars(from[i]);
        return result;
    },
    copyArrayOfRecords: function(from, to){
        to.splice(0, to.length);
        var length = from.length;
        if (!length)
            return;

        var method = from[0] instanceof Array 
                   ? this.cloneArrayOfRecords // this is array of arrays, go deeper
                   : this.cloneRecord;
        for(var i = 0; i < length; ++i)
            to.push(method.call(this, from[i]));
    },
    copyArrayOfScalars: function(from, to){
        to.splice(0, to.length);
        for(var i = 0; i < from.length; ++i)
            to.push(this.cloneArrayOfScalars(from[i]));
    },
    copyRecord: function(from, to){
        for(var prop in to){
            if (to.hasOwnProperty(prop)){
                var v = from[prop];
                var isScalar = prop[0] != "$";
                if (isScalar)
                    to[prop] = v;
                else
                    to[prop] = v instanceof Array ? this.cloneArrayOfRecords(v)
                                                  : this.cloneRecord(v);
            }
        }
    },
    cloneRecord: function(from){
        var Ctr = from.constructor;
        var result = new Ctr();
        this.copyRecord(from, result);
        return result;
    },
    assert: function(condition){
        if (!condition)
            throw new Error("assertion failed");
    }
};

exports.Class = Class;
exports.dependencies = { 
    "cloneRecord": ["copyRecord"],
    "cloneArrayOfRecords": ["cloneRecord"],
    "copyArrayOfRecords": ["cloneArrayOfRecords", "cloneRecord"],
    "copyArrayOfScalars": ["cloneArrayOfScalars"],
    "makeCharArray": ["__makeCharArray"],
    "__makeCharArray": ["__setupCharArrayMethods"]
};

for(var e in impl)
    exports[e] = impl[e];
