#!/usr/bin/env ruby
# frozen_string_literal: true
# Emit JSON array: [{"line" => 1, "name" => "Foo", "kind" => "function"|"class"|"type"}]
# for definition-aware chunking. Requires MRI Ruby with Ripper (stdlib).

require "json"
require "ripper"

RIPPER_SCRIPT_VERSION = 1

def line_from_tok(t)
  t.is_a?(Array) && t[2].is_a?(Array) && t[2][0].is_a?(Integer) ? t[2][0] : nil
end

def const_name_node(node)
  return nil unless node.is_a?(Array)
  case node[0]
  when :@const
    node[1]
  when :@ident
    node[1]
  when :@kw
    node[1] == "self" ? "self" : nil
  when :const_ref
    const_name_node(node[1])
  when :const_path_ref
    l = const_name_node(node[1])
    r = const_name_node(node[2])
    l && r ? "#{l}::#{r}" : l || r
  when :var_ref
    const_name_node(node[1])
  when :@ivar, :@cvar, :@gvar
    node[1]
  when :topref
    "Object"
  else
    nil
  end
end

def defs_method_name(sexp)
  return nil unless sexp.is_a?(Array) && sexp[0] == :defs
  # [:defs, recv, :@period, :@ident name, params, bodystmt]
  t = sexp[3]
  t.is_a?(Array) && t[0] == :@ident ? t[1] : nil
end

def def_name(sexp)
  return nil unless sexp.is_a?(Array) && sexp[0] == :def
  t = sexp[1]
  t.is_a?(Array) && t[0] == :@ident ? t[1] : nil
end

def call_chain_static?(call_sexp, base_const, method_name)
  return false unless call_sexp.is_a?(Array) && call_sexp[0] == :call
  cr = call_sexp[1]
  m = call_sexp[3]
  return false unless m.is_a?(Array) && m[0] == :@ident && m[1] == method_name
  c = const_name_node(cr)
  c == base_const
end

# RHS may be :method_add_arg (parens), :call, or :command_call (e.g. `Struct.new :a` without parens)
def struct_like_rhs?(rhs)
  if rhs.is_a?(Array) && rhs[0] == :method_add_arg
    inner = rhs[1]
    return true if inner.is_a?(Array) && inner[0] == :call && struct_call_chain?(inner)
  end
  if rhs.is_a?(Array) && rhs[0] == :call
    return struct_call_chain?(rhs)
  end
  if rhs.is_a?(Array) && rhs[0] == :command_call
    return struct_from_command_or_callish?(rhs)
  end
  false
end

# [:command_call, recv, period, :@ident, args] — e.g. `Struct.new :a`, `Data.define :a`
def struct_from_command_or_callish?(cc)
  return false unless cc.is_a?(Array) && cc[0] == :command_call
  m = cc[3]
  return false unless m.is_a?(Array) && m[0] == :@ident
  meth = m[1]
  c = const_name_node(cc[1])
  return false unless c
  (c == "Struct" && meth == "new") ||
    (c == "Data" && meth == "define") ||
    (c == "Class" && meth == "new") ||
    (c == "Module" && meth == "new")
end

def struct_call_chain?(call_sexp)
  call_chain_static?(call_sexp, "Struct", "new") ||
    call_chain_static?(call_sexp, "Data", "define") ||
    call_chain_static?(call_sexp, "Class", "new") ||
    call_chain_static?(call_sexp, "Module", "new")
end

def var_field_name(lhs)
  return nil unless lhs.is_a?(Array) && lhs[0] == :var_field
  t = lhs[1]
  return nil unless t.is_a?(Array)
  const_name_node(t)
end

def var_field_tok_line(lhs)
  return nil unless lhs.is_a?(Array) && lhs[0] == :var_field
  t = lhs[1]
  t.is_a?(Array) ? line_from_tok(t) : nil
end

def first_symbol_from_args(args_sexp)
  return nil unless args_sexp.is_a?(Array) && args_sexp[0] == :args_add_block
  a = args_sexp[1]
  a.is_a?(Array) && a[0] == :args_add && a[1] ? first_arg_symbol(a[1][0]) : first_arg_symbol(a) if a
end

def first_arg_symbol(n)
  return nil unless n.is_a?(Array)
  case n[0]
  when :symbol_literal
    sym = n[1]
    sym.is_a?(Array) && sym[0] == :symbol && sym[1].is_a?(Array) && sym[1][0] == :@ident ? sym[1][1] : nil
  when :args_add
    n[1] ? first_arg_symbol(n[1]) : nil
  when :args_add_block
    first_arg_symbol(n) # handled elsewhere
  else
    nil
  end
end

def first_label_name_from_bare_hash(bh)
  return nil unless bh.is_a?(Array) && bh[0] == :bare_assoc_hash
  h = bh[1]
  return nil unless h.is_a?(Array) && h[0] && h[0][0] == :assoc_new
  lab = h[0][1]
  lab.is_a?(Array) && lab[0] == :@label ? lab[1].chomp(":") : nil
end

def walk(sexp, out)
  return unless sexp.is_a?(Array)
  head = sexp[0]
  case head
  when :program
    stmts = sexp[1]
    stmts.is_a?(Array) && stmts.each { |st| walk(st, out) }
    return
  when :bodystmt
    # [:bodystmt, [[stmt, ...]...], rescue, else, ensure] — stmt list is like :program
    stmts = sexp[1]
    stmts.is_a?(Array) && stmts.each { |st| walk(st, out) if st }
    return
  when :def
    nm = def_name(sexp)
    l = line_from_tok(sexp[1]) if sexp[1]
    out << { "line" => l, "name" => nm, "kind" => "function" } if nm && l
  when :defs
    nm = defs_method_name(sexp)
    l = line_from_tok(sexp[3] || sexp[1])
    out << { "line" => l, "name" => nm, "kind" => "function" } if nm && l
  when :class
    n = const_name_node(sexp[1])
    l = line_from_tok(find_first_tok_for_const(sexp[1]) || sexp[1])
    out << { "line" => l, "name" => n, "kind" => "class" } if n && l
  when :module
    n = const_name_node(sexp[1])
    l = line_from_tok(find_first_tok_for_const(sexp[1]) || sexp[1])
    out << { "line" => l, "name" => n, "kind" => "class" } if n && l
  when :sclass
    l = any_line_in_subtree(sexp)
    out << { "line" => l, "name" => "singleton", "kind" => "class" } if l
  when :assign
    lhs, rhs = sexp[1], sexp[2]
    if lhs && rhs
      nm = var_field_name(lhs)
      l = var_field_tok_line(lhs)
      if nm && l && struct_like_rhs?(rhs) && /[A-Z]/.match?(nm[0] || "a")
        out << { "line" => l, "name" => nm, "kind" => "class" }
      end
    end
  when :command
    id = sexp[1]
    if id.is_a?(Array) && id[0] == :@ident && id[1] == "enum"
      l = line_from_tok(id)
      if l
        a = sexp[2]
        sym = first_symbol_from_args(a)
        if sym
          out << { "line" => l, "name" => sym, "kind" => "type" }
        else
          bh = a.is_a?(Array) && a[0] == :args_add_block && a[1] ? a[1][0] : nil
          if bh.is_a?(Array) && bh[0] == :bare_assoc_hash
            labn = first_label_name_from_bare_hash(bh)
            out << { "line" => l, "name" => labn, "kind" => "type" } if labn
          end
        end
      end
    end
  end
  sexp[1..].each { |c| walk(c, out) if c }
end

def any_line_in_subtree(node)
  return nil unless node.is_a?(Array)
  l = line_from_tok(node)
  return l if l
  node[1..].each { |c| x = any_line_in_subtree(c); return x if x }
  nil
end

def find_first_tok_for_const(n)
  return nil unless n.is_a?(Array)
  t = n[0]
  return n if t == :@const || t == :@ident
  if t == :const_path_ref
    r = n[2]
    return r if r.is_a?(Array) && (r[0] == :@const || r[0] == :@ident)
  end
  n[1..].each { |c| f = find_first_tok_for_const(c); return f if f }
  nil
end

def run_ripper_extract(src)
  begin
    sexp = Ripper.sexp(src)
  rescue StandardError
    sexp = nil
  end
  out = []
  walk(sexp, out) if sexp
  seen = {}
  uniq = out.reject do |e|
    k = [e["line"], e["name"]]
    if seen[k]
      true
    else
      seen[k] = true
      false
    end
  end
  uniq.sort_by! { |e| [e["line"], e["name"].to_s] }
  uniq
end

if __FILE__ == $PROGRAM_NAME
  path = ARGV[0]
  unless path
    warn "usage: ripper_definitions.rb <path_to_ruby_file>"
    exit 2
  end

  src = File.read(path, encoding: "UTF-8")
  uniq = run_ripper_extract(src)
  puts JSON.generate(uniq)
end
